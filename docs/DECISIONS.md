# Decision Log

Every significant decision, with the alternatives considered and why they were
rejected. This file is the source for the README's required sections
(concurrency approach, index explanations, waiting-list assumptions) and the
script for the technical walkthrough.

Format: what was decided, what else was on the table, why this one won.

---

## 1. Scope and time budget

**Decided:** roughly two full working days, covering every stated requirement
plus two extras — a `docker-compose` setup with multiple app replicas behind
nginx, and a seed script with `EXPLAIN ANALYZE` evidence for the index choices.

**Why:** the extras are what turn two of the task's claims ("works across
instances", "stays fast as data grows") from assertions into demonstrations, and
neither is expensive relative to its credibility.

**Build order** — the spine stays demoable at all times:

1. Schema + migrations
2. Auth (JWT, three roles)
3. Doctors, schedules, blocks
4. Availability (slot generator)
5. Booking with the exclusion constraint
6. Cancellation with the 2-hour rule
7. Concurrency proof
8. Reminders
9. Waiting list
10. Reconciliation sweeper
11. Analytics SQL
12. Seed + index evidence
13. README + recording

`docker-compose` is built early, not last, because the concurrency proof depends
on it. The README is written as work proceeds.

---

## 2. Roles: ADMIN kept as a third role

**Decided:** ADMIN, DOCTOR, PATIENT. Patients self-register. An ADMIN creates
doctors. Schedules, blocks and analytics are accessible to an ADMIN or to the
owning doctor, via one reusable ownership rule.

**Alternatives considered:**

- _Two roles only, doctors self-register._ Closest to the brief's wording, but
  then anyone can register as a doctor, which is a worse security story than an
  extra enum value.
- _Two roles, doctors exist only via seeds._ Simplest, but leaves no way to
  demonstrate doctor onboarding.

**Why:** doctors have to come from somewhere. Once ADMIN exists for that reason,
letting it manage schedules costs nothing — the ownership check is
"ADMIN or the addressed doctor", implemented once.

See `docs/FEATURES/Auth.md`.

---

## 3. Timezone: single clinic timezone from configuration

**Decided:** `CLINIC_TZ` (e.g. `Africa/Cairo`). Schedules store wall-clock time;
appointments and blocks store `timestamptz`. Conversion happens in exactly one
place — schedule expansion.

**Alternatives considered:**

- _Assume everything is UTC._ Simplest, but wrong for half the year in any
  DST-observing region, and wrong in a way that produces plausible-looking data
  rather than an error.
- _Per-doctor timezone._ Correct in general, but multi-timezone scheduling is a
  large problem and the task has one clinic.

**Why:** a schedule row saying "Sunday 10:00" is a different UTC instant in
January than in July. Expanding schedules in UTC silently drifts by an hour.
Multi-timezone support is documented as a known limitation, with the single
conversion point identified as where it would change.

See `docs/FEATURES/Availability.md`.

---

## 4. Booking concurrency: slot-grid validation plus a GiST exclusion constraint

**Decided:** two layers. The application rejects any booking not aligned to the
doctor's generated slot grid, and derives `end_at` server-side. PostgreSQL then
enforces non-overlap:

```sql
EXCLUDE USING gist (
  doctor_id WITH =,
  tstzrange(start_at, end_at, '[)') WITH &&
) WHERE (status = 'CONFIRMED')
```

**Alternatives considered:**

- _Application-level check only._ Rejected outright — the gap between `SELECT`
  and `INSERT` is the race.
- _Partial unique index on `(doctor_id, start_at)`._ Handles the simple
  same-instant race, but not overlap. Because slot duration lives per schedule
  row and may change without rewriting history, a 30-minute appointment at 10:00
  can coexist with a new 15-minute booking at 10:15 — distinct keys, real
  overlap.
- _PostgreSQL advisory locks._ No extension needed, but protects only code paths
  that remember to take the lock, and hash collisions serialize unrelated slots.
- _Pessimistic row locking._ There is no row to lock when the slot is empty.

**Why:** the constraint protects the _table_, so the waiting-list job, the seed
script and manual `psql` access are all covered without remembering anything.

Two details that matter: the range bound is half-open `'[)'` so back-to-back
slots don't collide, and the constraint is partial so cancelled rows don't block
rebooking.

See `docs/INFRASTRUCTURE/Concurrency.md`.

---

## 5. Waiting list: FIFO auto-assignment with expiry

**Decided:** on cancellation, a background job books the earliest eligible
`WAITING` entry directly. No confirmation step. Entries expire when the slot time
passes or at an optional patient-supplied `expires_at`.

**Alternative considered:** _offer-with-hold_ — reserve the slot for the first
waiter for a claim window, pass it on if unclaimed. Closer to real clinic
behaviour and avoids booking someone who never re-consented.

**Why rejected for now:** it adds a third writer competing for every slot
(direct booker, hold claimer, expiry job), a `PENDING_CLAIM` appointment state
the overlap constraint must also cover, and a re-offer chain. Roughly double the
work and most of the remaining bug surface, for a part of the task explicitly
left open. Recorded as the natural next step.

Full assumption list in `docs/FEATURES/WaitingList.md`.

---

## 6. Job durability: enqueue after commit, idempotent jobs, reconciliation sweeper

**Decided:** PostgreSQL and Redis cannot commit together, so:

1. Jobs are enqueued only after the transaction commits.
2. Job payloads carry identifiers, never state. Workers re-derive every decision
   from the database.
3. A repeatable sweeper re-derives pending work, closing the crash window between
   commit and enqueue.

**Alternatives considered:**

- _Enqueue inside the transaction._ A worker can start before the commit lands,
  read stale state, correctly decide to do nothing, and the work is lost
  permanently with no trace.
- _Transactional outbox plus poller._ Strictly stronger — nothing can ever be
  lost. Rejected as disproportionate: it means building, testing and explaining a
  second queueing mechanism to remove a window the sweeper already covers.
- _Enqueue after commit with no sweeper._ Accepts silent loss on a crash, and
  also has no answer for Redis losing its delayed jobs.

**Why:** three small parts, each explainable in a sentence, and the sweeper
doubles as the recovery story for a Redis restart. Redis is treated as a
scheduler; PostgreSQL is the store of record.

Idempotency is a unique constraint plus a _conditional_ status update acted on by
affected row count — checking then writing is itself a race between two workers.

See `docs/INFRASTRUCTURE/BackgroundJobs.md`.

---

## 7. One `notifications` table instead of a separate `reminders` table

**Decided:** a single table with a `type` column (`REMINDER`,
`WAITLIST_ASSIGNED`), `UNIQUE (appointment_id, type)`.

**Why:** both job types need the same "have we already done this?" check. One
table means one unique constraint, one conditional-update pattern and one
repository, instead of implementing idempotency twice.

The row is written inside the business transaction; the BullMQ job is enqueued
after commit. That ordering is what lets the sweeper rebuild lost jobs from the
database.

---

## 8. Module boundaries: the job processor orchestrates

**Decided:** `waiting-list.processor.ts` calls both `WaitingListService` and a
narrow method on `AppointmentsService`. The two feature modules never import each
other; only `JobsModule` imports both.

**Alternative considered:** having `AppointmentsService` call `WaitingListService`
directly on cancel, which creates a circular module dependency requiring
`forwardRef` and blurs which module owns booking rules.

Also decided: an injectable `Clock` in `common/clock`. Every time-dependent rule
reads `now()` through it. Without this the 2-hour cancellation window cannot be
unit-tested deterministically.

See `docs/ARCHITECTURE.md`.

---

## 9. Analytics definitions

**Decided**, all computed in SQL:

- _Total appointments_ — every appointment starting in the month, CONFIRMED and
  CANCELLED alike.
- _Cancellation rate_ — cancelled / total × 100, guarded with `NULLIF`.
- _Peak booking hours_ — grouped by the hour of the appointment's start time in
  clinic-local time, ties all returned.
- _Utilization_ — booked confirmed minutes / available scheduled minutes × 100,
  where capacity is the weekly schedule expanded across the month minus blocks.

**Ambiguities resolved deliberately:** "peak booking hours" could mean the hour
the booking was _created_; the appointment hour was chosen because it answers
which hours of the working day are busiest. Utilization is minutes-based rather
than slot-count-based because summing interval durations avoids a nested
`generate_series` over every individual slot while producing the same ratio.

Month boundaries are taken in clinic-local time, not UTC, so appointments near
midnight land in the right month.

See `docs/FEATURES/Analytics.md`.

---

## 10. Concurrency proof runs against multiple instances

**Decided:** `docker-compose` runs nginx in front of two or more app replicas,
and the proof script fires at nginx. It asserts exactly one 201, all others
exactly 409 (not merely "not 201"), zero 5xx, and exactly one CONFIRMED row.

**Alternative considered:** parallel requests against a single process. This does
exercise the database constraint correctly and is much less setup — but the
task's stated threat model is several instances behind a load balancer, so the
proof should match the claim.

**Why assert 409 specifically:** a 500 is also a failed booking, but it means the
constraint fired while the error mapping did not. A looser assertion hides that.

See `docs/TESTING.md`.

---

## 11. API surface and contracts

**Decided:** a small REST surface, documented in `docs/API.md`. Three choices
inside it carry real weight.

**`endAt` is never accepted from the client.** The booking body is
`{ doctorId, startAt }`; the server derives the end from the matching schedule
row's slot duration, and the patient comes from the JWT.

_Why:_ a client able to supply `endAt` could craft a 5-minute appointment inside
a 30-minute slot. The exclusion constraint would still prevent overlap, so
nothing would fail loudly — but the slot grid would rot and availability
listings would drift away from reality.

**Cancel is `POST /appointments/:id/cancel`, not `DELETE /appointments/:id`.**
The row is retained as CANCELLED for analytics, so a `DELETE` verb would
advertise the opposite of what happens. Leaving the waiting list _is_ a real
removal, so that one is a `DELETE`.

**Errors carry a machine-readable `code` alongside the status.** Several distinct
conditions share `409` — slot taken, already queued, cancellation window passed.
Tests and the concurrency script assert on `code`, never on message text.

Also decided: schedules, blocks and analytics are nested under
`/doctors/:doctorId/...` so the ownership guard has an explicit subject; the
2-hour window returns `409` rather than `400` because the request is well-formed
and it is the resource state that refuses it; and `GET /health` exists because
nginx and compose both depend on it.

---

## 12. Analytics: one query, with two traps handled explicitly

**Decided:** a single raw SQL query built from CTEs — `params`, `stats`,
`hourly`, `peak`, `days`, `windows`, `blocked`, `capacity` — each with one job.
Documented in `docs/FEATURES/Analytics.md`.

**Trap 1: `EXTRACT(DOW)` forces a schema convention.** Postgres returns 0 for
Sunday, so `schedules.day_of_week` must use 0 = Sunday. Storing ISO 1 = Monday
would shift every schedule by one day while still looking internally consistent.
The column carries a migration comment and a `CHECK` for this reason.

**Trap 2: subtracting blocks one at a time can double-count.** Intersecting each
block with a working window separately subtracts any shared minute twice, so
utilization can exceed 100% or go negative. Overlapping blocks are rejected at
write time (#18), so no legal row can trigger this — but the query still merges
blocks with `range_agg` into one multirange _before_ subtraction, because
multirange difference is a single operator that is structurally incapable of
subtracting a minute twice. It costs nothing and does not depend on the
constraint being in place.

`range_agg` requires PostgreSQL 14+, which is why compose pins 16.

Capacity sums window durations rather than generating individual slots. Same
ratio, far less to reason about, and no nested `generate_series`.

---

## 13. Workers run as a separate service from the API

**Decided:** one codebase, two bootstraps. `api` scales to two replicas for the
concurrency proof; `worker` runs the BullMQ processors at one replica.

**Alternative considered:** registering processors inside the API bootstrap. One
fewer service, and it works.

**Why rejected:** it couples two unrelated capacities. Scaling the API to two
replicas would silently double the worker pool as a side effect — a change to
request capacity quietly changing job concurrency. Separating them also keeps a
worker holding a connection during a waiting-list assignment from competing with
HTTP requests for the pool.

See `docs/INFRASTRUCTURE/Deployment.md`.

---

## 14. Redis is ephemeral, and migrations run as a one-shot service

**Decided:** Redis runs with no persistence — no `--appendonly`, no named
volume. Restarting Redis loses whatever delayed jobs were sitting in it.

**Alternative considered:** `--appendonly yes` on a named volume so the delayed
set survives a restart. That was the earlier decision here, and it was reversed.

_Why:_ losing the delayed set costs nothing that matters. Every reminder already
has a `PENDING` `notifications` row in PostgreSQL, and the sweeper sends anything
whose `scheduled_at` has passed. A restart therefore delays a due reminder by up
to a minute — the same bound already accepted for a lost enqueue — and leaves
future reminders untouched, because they fire from the sweeper when their time
arrives. Persistence would not change one correctness claim: "at most one
reminder" comes from `UNIQUE (appointment_id, type)` plus the conditional status
update, never from Redis.

Keeping Redis disposable also makes the design statement literally true rather
than a caveat. Redis is a scheduler; PostgreSQL is the store of record. A durable
Redis would hold a second copy of the same intent that the project then has to
explain it does not trust.

**Decided:** a `migrate` one-shot service runs migrations and exits; `api` and
`worker` wait on `service_completed_successfully`.

_Why:_ `docker compose up` stays a single command while `synchronize: true` stays
permanently off. Running migrations inside app startup would have both API
replicas migrating concurrently on a cold start — TypeORM's advisory lock usually
handles it, but "usually" is a poor property for schema changes, and a failed
migration should stop the stack with an obvious cause rather than leave replicas
crash-looping.

---

## 15. Smaller decisions

- **Availability range cap: 62 days.** Slot generation is linear in days;
  62 covers "browse the next two months" while bounding per-request work.
- **Reminders scheduled in the past fire immediately.** When an appointment is
  booked under 24 hours out, the notification row is still created and the job
  runs with no delay. Skipping it would also be defensible, but firing keeps the
  invariant "every confirmed appointment has exactly one reminder record", which
  is simpler to state and to test.
- **Waiting-list expiry is swept, not scheduled per entry.** Expiry has no side
  effects and needs no second-level timeliness, so one periodic query beats
  thousands of delayed jobs.
- **`appointments.created_from`** (`DIRECT` / `WAITING_LIST`) — one column that
  makes waiting-list assignment provable in the database during the demo.
- **Cancelled appointments are never deleted.** Required for analytics, and the
  reason the overlap constraint is partial.
- **Overlapping schedule rows are validated in the service layer**, because
  PostgreSQL has no built-in range type over `time`. A documented gap rather than
  an oversight.
- **`schedules.day_of_week` uses 0 = Sunday**, matching `EXTRACT(DOW)`. Forced by
  the analytics query, not a preference.
- **Version pins: PostgreSQL 16, Redis 7.** `range_agg` needs 14+; pinning majors
  keeps a rebuild months from now from changing behaviour underneath the project.
- **A 409 on booking tells the client the waiting list is available.** One extra
  field that turns a dead end into the entry point for the waiting-list flow, and
  makes the demo move naturally between features.
- **Waiting-list position is derived on read**, counting earlier `WAITING`
  entries, never stored. A stored position would need renumbering on every
  removal.
- **`GET /health` is part of the system.** nginx uses it to avoid routing to
  booting replicas, which also keeps the concurrency proof clean — a request
  failing because a replica was not ready would muddy the result.

---

## 16. A patient cannot hold two overlapping appointments either

**Decided:** a second exclusion constraint, `appointments_patient_no_overlap`,
mirroring the doctor constraint on `patient_id`.

**Alternative considered:** allowing it, on the grounds that the task does not
ask for it and a patient might be booking on behalf of a family member.

**Why the constraint won:** a patient physically cannot attend two appointments
at once, so allowing it stores data that cannot be true. Booking for a family
member is better served by that person having their own account than by leaving
an invariant unenforced. The constraint also provides the `(patient_id, ...)`
index that the "am I already busy then?" pre-check needs.

## Consequence: the constraint name has to be part of error handling

Both constraints raise SQLSTATE `23P01` while meaning different things:

- `appointments_no_overlap` — the doctor's slot is gone. Nothing to retry.
- `appointments_patient_no_overlap` — the slot is still free; _this patient_ is
  busy elsewhere.

So the error handler branches on constraint name, returning
`SLOT_ALREADY_BOOKED` or `PATIENT_ALREADY_BOOKED`. Reporting the first for the
second case would be actively misleading.

The waiting-list job needs the same distinction with a bigger consequence. On the
doctor constraint it stops; on the patient constraint it **moves to the next
candidate**, because the slot is still assignable. That turns the assignment step
into a bounded candidate loop with a `SAVEPOINT` per attempt — an error aborts a
PostgreSQL transaction, so without savepoints the first ineligible candidate
would destroy the whole transaction. Detail in `docs/FEATURES/WaitingList.md`.

This is the clearest example in the project of a small schema decision reaching
into application control flow, and it is worth walking through on the call.

---

## 17. Residual decisions

- **Sweeper interval: every minute.** Recovery from a lost job is bounded by
  about a minute, the queries are indexed lookups over small result sets, and it
  is short enough to demonstrate live in the recording without waiting.
- **No default waiting-list expiry.** `expires_at` stays optional and
  patient-supplied; entries expire implicitly when the slot's start time passes.
  A "48 hours after joining" default was considered, but expiry is already
  bounded and a default would need explaining without changing behaviour in any
  case that matters.
- **Seed distribution is skewed, not uniform.** A few popular doctors hold a
  disproportionate share, spread over ~24 months, ~15% cancelled. Uniform rows
  per doctor would be the easiest possible case for every index; the skew
  produces the worst case, and the busiest doctor's plan is the number worth
  reporting. `EXPLAIN ANALYZE` is measured against a busy doctor, not an average
  one.

---

## 18. A doctor's blocks may not overlap

**Decided:** one period of unavailability is one row. Enforced by an exclusion
constraint and mapped to `409 BLOCK_OVERLAP`.

```sql
ALTER TABLE blocks ADD CONSTRAINT blocks_no_overlap
  EXCLUDE USING gist (
    doctor_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  );
```

**Alternative considered, and previously decided the other way:** allowing
overlap, on the grounds that a vacation day might contain an emergency block.
Reversed.

**Why:** a block means "the doctor is unavailable for this period", whether the
cause was planned (vacation) or unexpected (family emergency, illness, an urgent
hospital case). Recording an emergency inside a vacation day states
unavailability that is already stated, so the second row carries no information
while every consumer of `blocks` — availability, booking, the capacity query —
has to reason about the pair. Rejecting the overlap removes a case instead of
handling it in three places.

**Why a constraint rather than a service check:** `blocks` stores `timestamptz`,
so `tstzrange` exists and `btree_gist` is already installed for the appointment
constraints. This is one line of DDL that protects the table itself, including
the seed script. The comparison with schedules is instructive: that rule stays in
the service layer only because PostgreSQL ships no range type over `time`
(see "Known gap" in `docs/DATABASE.md`), not because service-layer validation was
preferred.

The bound is half-open `'[)'`, matching every other range in the schema, so
adjacent blocks such as 10:00–11:00 and 11:00–12:00 are still accepted. Blocks
have no status column, so unlike the appointment constraints this one is not
partial — deleting a block is a real delete, and there is no `PATCH`, so widening
a block is delete-then-create.
