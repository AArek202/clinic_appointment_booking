# Clinic Appointment Booking

A NestJS + PostgreSQL appointment booking API for a clinic: doctors with weekly
schedules and blocked periods, patients booking against a generated slot grid,
a FIFO waiting list that fills cancelled slots automatically, appointment
reminders, and per-doctor monthly analytics computed in SQL.

The interesting part is not the CRUD. Several API instances run behind a load
balancer and none of them may double-book a slot — that is a database problem,
not an application one. [How double booking is prevented](#how-double-booking-is-prevented)
is the short answer.

## Table of contents

1. [Quick start](#quick-start)
2. [Configuration](#configuration)
3. [Seeding a realistic dataset](#seeding-a-realistic-dataset)
4. [API surface](#api-surface)
5. [How double booking is prevented](#how-double-booking-is-prevented)
6. [Database design and indexes](#database-design-and-indexes)
7. [Waiting list: model and assumptions](#waiting-list-model-and-assumptions)
8. [Background jobs and durability](#background-jobs-and-durability)
9. [Analytics definitions](#analytics-definitions)
10. [Testing](#testing)
11. [Performance evidence](#performance-evidence)
12. [Known limitations and what I would do next](#known-limitations-and-what-i-would-do-next)
13. [How AI was used](#how-ai-was-used)
14. [Screen recording](#screen-recording)

---

## Quick start

Requires Docker and Docker Compose. Node.js is only needed if you run tests or
the seed script on the host.

```bash
git clone <repository-url>
cd DAF
cp .env.example .env
cp clinic_appointment_booking/.env.example clinic_appointment_booking/.env
docker compose up --build
```

That starts: `postgres`, `redis`, a one-shot `migrate` job, **two** `api`
replicas, one `worker`, and `nginx` in front of the API.

```mermaid
flowchart LR
  Client["HTTP client\n:8080"] --> nginx["nginx"]
  nginx --> api1["api replica 1"]
  nginx --> api2["api replica 2"]
  api1 --> pg[(PostgreSQL)]
  api2 --> pg
  api1 --> redis[(Redis)]
  api2 --> redis
  worker["worker\n(BullMQ)"] --> pg
  worker --> redis
  migrate["migrate\n(one-shot)"] --> pg
```

The API is published on **`http://localhost:8080`** through nginx. The `api`
containers do not publish host ports — there are two of them, and a fixed port
mapping would only reach one.

```bash
curl http://localhost:8080/health
# {"status":"ok","database":"up"}
```

`migrate` runs TypeORM migrations and exits 0 before `api` or `worker` start.
`synchronize: true` is off everywhere, including in tests. If a migration fails,
the stack stops with that as the visible cause instead of leaving replicas
crash-looping against a mismatched schema.

To stop and wipe data volumes:

```bash
docker compose down -v
```

Application code lives in [`clinic_appointment_booking/`](clinic_appointment_booking/).
Project design docs live in [`docs/`](docs/).

---

## Configuration

Two env files, two roles:

| File | Loaded by |
|---|---|
| [`.env.example`](.env.example) → `.env` | Docker Compose (ports, JWT, `CLINIC_TZ`) |
| [`clinic_appointment_booking/.env.example`](clinic_appointment_booking/.env.example) → `.env` | NestJS on the host (`DATABASE_URL`, etc.) |

Keep credentials and published ports in sync between them.

| Variable | Example | Notes |
|---|---|---|
| `NODE_ENV` | `development` | |
| `PORT` | `3000` | Port inside the `api` container. nginx publishes 8080. |
| `DATABASE_URL` | `postgres://clinic:clinic@postgres:5432/clinic` | In Docker. Use `localhost:5432` on the host. |
| `TEST_DATABASE_URL` | `postgres://clinic:clinic@localhost:5433/clinic_test` | Integration suite only. |
| `REDIS_URL` | `redis://redis:6379` | |
| `JWT_SECRET` | 32+ characters | Validated at startup. |
| `JWT_EXPIRES_IN` | `1d` | |
| `CLINIC_TZ` | `Africa/Cairo` | **Business configuration**, not deployment detail. |

`CLINIC_TZ` changes what the API **computes**: a schedule row "Sunday 10:00" is
a different UTC instant in January than in July. It is validated against the IANA
database at startup — a typo fails boot with a clear message rather than
producing slots that drift by an hour for half the year.

---

## Seeding a realistic dataset

```bash
docker compose --profile seed up seed
```

Or from `clinic_appointment_booking/` on the host:

```bash
npm run seed:reset      # full scale (~2M appointments, ~15–25 min)
npm run seed:small      # ~1% for fast iteration (empty DB only)
```

`seed` and `seed:small` refuse to run if `appointments` already has rows. Use
`npm run seed:reset` (full) or add `--reset` yourself for a small wipe-and-reload.

The seed is behind a Compose **profile** because it takes minutes — it should
not run on every `docker compose up`.

**What gets loaded (full scale):** ~200 doctors, 120,000 patients, just over
2 million appointments, notifications, waiting-list entries, schedules and
blocks — spread across 24 months.

The distribution is deliberately **skewed, not uniform**. A few popular doctors
hold several times the median; ~15% of appointments are cancelled; recent months
are denser than old ones. Uniform rows per doctor would be the easiest case for
every index; the skew produces the worst case, and the busiest doctor's plan is
the one worth reporting ([section 11](#performance-evidence)).

```mermaid
flowchart LR
  subgraph gen [In-memory generators]
    people[People]
    sched[Schedules + blocks]
    appts[Appointments]
    wl[Waiting list]
  end
  subgraph load [PostgreSQL COPY]
    copy["COPY ... FROM STDIN\n(constraints ON)"]
  end
  people --> copy
  sched --> copy
  appts --> copy
  wl --> copy
```

Rows load via `COPY ... FROM STDIN` in 50,000-row transactions with **every
constraint enabled**. The load is itself a correctness test: a generator bug fails
with SQLSTATE `23P01`, not quiet bad data.

The seed is **deterministic** (fixed PRNG seed) so performance numbers in
section 11 are reproducible.

Every seeded account uses password **`Password123!`**. Admin: **`admin@clinic.test`**.

---

## API surface

Full contracts in [`docs/API.md`](docs/API.md).

```text
POST   /auth/register                             public, always creates a PATIENT
POST   /auth/login                                public
GET    /auth/me                                   any authenticated

POST   /doctors                                   ADMIN
GET    /doctors                                   any authenticated
GET    /doctors/:id                               any authenticated

GET    /doctors/:doctorId/schedules               any authenticated
POST   /doctors/:doctorId/schedules               ADMIN or owning doctor
PATCH  /doctors/:doctorId/schedules/:id           ADMIN or owning doctor
DELETE /doctors/:doctorId/schedules/:id           ADMIN or owning doctor

GET    /doctors/:doctorId/blocks                  any authenticated
POST   /doctors/:doctorId/blocks                  ADMIN or owning doctor
DELETE /doctors/:doctorId/blocks/:id              ADMIN or owning doctor

GET    /doctors/:doctorId/availability?from&to    any authenticated
GET    /doctors/:doctorId/analytics?year&month    ADMIN or owning doctor
GET    /doctors/:doctorId/appointments            ADMIN or owning doctor

POST   /appointments                              PATIENT
GET    /appointments/me                           PATIENT
POST   /appointments/:id/cancel                   PATIENT (owner) or ADMIN

POST   /waiting-list                              PATIENT
GET    /waiting-list/me                           PATIENT
DELETE /waiting-list/:id                          PATIENT (owner)

GET    /health                                    public
```

Three choices carry weight:

**`endAt` is never accepted from the client.** The body is `{ doctorId, startAt }`;
the server derives the end from the schedule's slot duration. A client-supplied
`endAt` could craft a five-minute appointment inside a thirty-minute slot. The
exclusion constraint would still prevent overlap, but the slot grid would rot.

**Cancel is `POST /appointments/:id/cancel`, not `DELETE`.** The row stays as
`CANCELLED` for analytics. Leaving the waiting list *is* a real removal, so that
one is `DELETE`.

**Errors carry a machine-readable `code`.** Several conditions share `409`.
Tests and the concurrency script assert on `code`, not message text.

```json
{
  "statusCode": 409,
  "code": "SLOT_ALREADY_BOOKED",
  "message": "This slot has just been booked by another patient.",
  "waitingListAvailable": true
}
```

---

## How double booking is prevented

Several API instances can receive booking requests for the same slot at the same
moment. Each can check availability, see the slot free, and insert. An
application-level check alone is not protection — the gap between `SELECT` and
`INSERT` is the race.

```mermaid
sequenceDiagram
  participant P1 as Patient A (api-1)
  participant P2 as Patient B (api-2)
  participant DB as PostgreSQL

  P1->>DB: INSERT appointment (slot X)
  P2->>DB: INSERT appointment (slot X)
  Note over DB: GiST exclusion constraint
  DB-->>P1: OK (1 row)
  DB-->>P2: 23P01 → mapped to 409
```

### Layer 1 — snap to the slot grid (application)

`POST /appointments` accepts `{ doctorId, startAt }`. The server finds the
schedule for that weekday in `CLINIC_TZ`, verifies `startAt` lands on a slot
boundary, and derives `endAt`. Off-grid requests get `400 SLOT_NOT_ON_GRID`.

```mermaid
flowchart TD
  sched["Weekly schedule\n(Sun 09:00–13:00, 15 min)"]
  expand["expand in CLINIC_TZ\nover date range"]
  grid["Slot grid\n[09:00,09:15) [09:15,09:30) …"]
  blocks["Subtract blocks +\nbooked slots"]
  avail["Available slots API"]
  sched --> expand --> grid --> blocks --> avail
```

### Layer 2 — PostgreSQL enforces non-overlap (database)

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE appointments ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (
    doctor_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (status = 'CONFIRMED');
```

Booking inserts and handles rejection. The constraint protects the **table**, so
the waiting-list job, the seed script and manual `psql` access are covered too.

Load-bearing details:

- Range bound `'[)'` — half-open. With inclusive bounds, 10:00–10:30 and
  10:30–11:00 would count as overlapping.
- Partial on `status = 'CONFIRMED'`. Cancelled rows stay for analytics and must
  not block rebooking.

### Alternatives considered

| Approach | Why not |
|---|---|
| Application check only | The SELECT/INSERT gap is the race. |
| Partial unique on `(doctor_id, start_at)` | Catches identical starts, not overlap when slot duration varies. |
| Advisory locks | Only protects code paths that remember to lock; hash collisions serialise unrelated slots. |
| Pessimistic row lock | No row to lock when the slot is empty. |
| Redis distributed lock | If Redis is down you stop booking or fall back to the database — which was the real protection anyway. |

### Two exclusion constraints, not one

A patient cannot attend two appointments at once:

```sql
ALTER TABLE appointments ADD CONSTRAINT appointments_patient_no_overlap
  EXCLUDE USING gist (
    patient_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (status = 'CONFIRMED');
```

Both raise SQLSTATE `23P01`; error handling branches on **constraint name**:

| Constraint | HTTP code | Meaning |
|---|---|---|
| `appointments_no_overlap` | `409 SLOT_ALREADY_BOOKED` | Doctor's slot is gone. |
| `appointments_patient_no_overlap` | `409 PATIENT_ALREADY_BOOKED` | Slot may still be free; this patient is busy elsewhere. |

The waiting-list assignment job needs the same distinction: on the doctor
constraint it **stops**; on the patient constraint it tries the **next**
candidate. Each attempt uses a `SAVEPOINT` so one failure does not abort the
whole transaction.

```mermaid
flowchart TD
  start[Pick next WAITING entry FIFO]
  try[INSERT appointment]
  done[ASSIGNED + notify]
  next[Next candidate]
  stop[Stop — slot taken]

  start --> try
  try -->|OK| done
  try -->|23P01 doctor overlap| stop
  try -->|23P01 patient overlap| next
  next --> start
```

### Proof

From `clinic_appointment_booking/`:

```bash
npm run test:concurrency
```

Fires simultaneous requests at **nginx** (two API replicas). Expected:

```text
Successful bookings: 1
Conflicted bookings (409): 9
Unexpected errors (5xx): 0
Confirmed appointments in DB: 1
```

Asserting `409` specifically matters: a `500` is also a failed booking but means
the constraint fired while error mapping did not.

Details: [`docs/INFRASTRUCTURE/Concurrency.md`](docs/INFRASTRUCTURE/Concurrency.md)

---

## Database design and indexes

Schema and conventions: [`docs/DATABASE.md`](docs/DATABASE.md)

- Instant columns: `timestamptz`, named `*_at`
- Wall-clock columns: `time`, named `*_time`
- `schedules` stores wall-clock time (no timezone); `appointments` and `blocks`
  store UTC instants. Conversion happens in **one place**: schedule expansion.
- `schedules.day_of_week`: **0 = Sunday** … 6 = Saturday (matches `EXTRACT(DOW)`)

### Every index exists for a named query

`appointments` is write-heavy; the list is deliberately short. Section 11 has
measured plans.

| Index | Table | Serves |
|---|---|---|
| `appointments_no_overlap` (GiST, partial) | appointments | Booking invariant **and** "taken slots for doctor in range" (availability). |
| `appointments_patient_no_overlap` (GiST, partial) | appointments | Patient invariant + busy pre-check. |
| `appointments_patient_start_idx` (btree) | appointments | `GET /appointments/me`, cancel ownership. |
| `appointments_doctor_start_at_idx` (btree) | appointments | Monthly analytics **and** `GET /doctors/:doctorId/appointments` (includes CANCELLED — cannot use partial GiST). |
| `blocks_doctor_id_start_at_end_at_idx` (btree) | blocks | Block subtraction during slot generation. |
| `blocks_no_overlap` (GiST) | blocks | Invariant: one period of unavailability per row. |
| `waiting_list_slot_status_idx` (btree) | waiting_list | Assignment job + sweeper. |
| `waiting_list_one_active` (unique partial) | waiting_list | One active entry per patient per slot. |
| `notifications_unique_per_type` (unique) | notifications | One notification per type per appointment; job idempotency. |
| `notifications_pending_due_idx` (partial) | notifications | Sweeper: due-but-unsent reminders. |

Four indexes come from constraints — the invariant and the index cannot drift apart.

### Documented gap

PostgreSQL has no built-in range type over `time`, so overlapping **schedule**
rows on the same weekday are validated in the service layer, not by an exclusion
constraint. **Blocks** use `timestamptz`, so `blocks_no_overlap` enforces them in
the database.

---

## Waiting list: model and assumptions

When a slot is taken, `409 SLOT_ALREADY_BOOKED` includes `waitingListAvailable:
true`. On cancellation, a background job assigns the slot to the earliest
eligible waiter — **no confirmation step**.

Assumptions (task left this open; these are what was built):

1. **FIFO** by `created_at`
2. No priority tiers
3. At most **one active entry** per patient per slot (partial unique index)
4. A patient may queue for **several different slots**
5. Cannot queue for a slot they already hold as CONFIRMED
6. Cannot queue for a **free** slot (`409 SLOT_IS_AVAILABLE`)
7. Entries expire when the slot starts, or at optional `expires_at` before start
8. Assignment is **async** (BullMQ), not inside the cancel request
9. Assignment is transactional and **retry-safe**
10. Assigned rows use `created_from = 'WAITING_LIST'`
11. Assigned patients get a REMINDER notification like direct bookings
12. Notifications are **rows + log lines** — no real email/SMS
13. Queue position is **derived on read**, not stored

```mermaid
sequenceDiagram
  participant P1 as Patient 1
  participant API
  participant DB as PostgreSQL
  participant Q as BullMQ
  participant W as Worker

  P1->>API: Book slot
  API->>DB: INSERT → OK
  participant P2 as Patient 2
  P2->>API: Book same slot
  API->>DB: INSERT → 409 SLOT_ALREADY_BOOKED
  P2->>API: Join waiting list
  P1->>API: Cancel appointment
  API->>DB: status = CANCELLED
  API->>Q: enqueue waiting-list job
  Q->>W: process slot
  W->>DB: assign P2, notify
```

### Alternative rejected: offer-with-hold

Reserve the slot for the first waiter with a claim window. Closer to real clinics,
but adds a third writer, a `PENDING_CLAIM` state, and re-offer chains — roughly
double the waiting-list surface for a part of the task explicitly left open.

Full detail: [`docs/FEATURES/WaitingList.md`](docs/FEATURES/WaitingList.md)

---

## Background jobs and durability

Reminders and waiting-list processing run on BullMQ in a separate **`worker`**
service. PostgreSQL is the store of record; Redis is a scheduler.

```mermaid
flowchart TD
  subgraph api [API]
    write[Write appointment / notification row]
    commit[COMMIT]
    enqueue[Enqueue BullMQ job]
    write --> commit --> enqueue
  end
  subgraph worker [Worker]
    job[Process job]
    idem["Idempotency:\nUNIQUE + conditional UPDATE"]
    job --> idem
  end
  subgraph sweep [Sweeper every ~1 min]
    scan[Scan PENDING notifications\n+ stranded waiting list]
    scan --> job
  end
  enqueue --> job
  pg[(PostgreSQL)] --> scan
```

Three rules:

1. **Enqueue only after commit** — otherwise a worker may read stale state and
   exit permanently.
2. **Payloads carry identifiers only** — workers re-derive decisions from the DB.
3. **Reconciliation sweeper ~every minute** — recovers lost jobs; bounds recovery
   after Redis restart.

Idempotency: unique constraint + **conditional** status update (`UPDATE … WHERE
status = 'PENDING'`; zero rows = already done). "Check then act" is a race.

Redis has **no persistence volume**. Delayed jobs live in Redis until they fire;
a restart drops them — but every reminder has a `PENDING` row in PostgreSQL and
the sweeper sends anything past `scheduled_at`.

**Transactional outbox** was considered and rejected as disproportionate; the
sweeper closes the window within about a minute.

Workers run as a **separate service**, not in-process with the API, so scaling
HTTP replicas does not silently double job concurrency.

More: [`docs/INFRASTRUCTURE/BackgroundJobs.md`](docs/INFRASTRUCTURE/BackgroundJobs.md)

---

## Analytics definitions

`GET /doctors/:doctorId/analytics?year=YYYY&month=M` — four metrics in one raw
SQL query (CTEs). Full derivation:
[`docs/FEATURES/Analytics.md`](docs/FEATURES/Analytics.md)

| Metric | Definition |
|---|---|
| Total appointments | All rows with `start_at` in the month (CONFIRMED + CANCELLED). |
| Cancellation rate | `cancelled / total × 100` (`NULLIF` on empty month). |
| Peak booking hours | Hour of **appointment start** in clinic-local time (not `created_at`). |
| Utilization | Confirmed booked minutes / available scheduled minutes × 100. |

Utilization expands weekly schedules over the month, subtracts merged blocked
time (`range_agg` before subtraction — avoids double-counting), and compares to
confirmed appointment minutes.

Month boundaries use **clinic-local time**, not UTC.

---

## Testing

Compose lives at the **repository root**. npm scripts live in
`clinic_appointment_booking/`.

```bash
# from the repository root
docker compose --profile test up -d postgres-test

# from clinic_appointment_booking/
npm test                                          # unit tests
npm run test:e2e                                  # integration, real PostgreSQL
npm run test:concurrency                          # proof via nginx → 2 replicas
npm run typecheck                                 # src + test TypeScript
```

Testing targets business-critical behaviour, not a coverage percentage.

- Time-dependent rules (cancellation window, reminder offset, waiting-list
  expiry) read time through an injected **`Clock`**, with a fixed clock in tests.
- Slot generator gets dense unit coverage (grid, blocks, DST, half-open bounds).
- Integration tests use real PostgreSQL with **migrations**, never
  `synchronize: true`.
- Concurrency test uses real PostgreSQL and nginx — mocking the DB would mock
  away what is being proved.

Strategy: [`docs/TESTING.md`](docs/TESTING.md)

---

## Performance evidence

Measured against the seeded dataset in [section 3](#seeding-a-realistic-dataset):
200 doctors, **2,029,903** appointments (300,682 cancelled, 14.8%), 2,081,654
notifications, 60,000 waiting-list entries, skewed over 24 months. The busiest
doctor holds 24,386 rows; the quietest holds 3,875 (6.3×). **Every query below
is that busiest doctor**, not an average one.

Each "without index" plan drops the index inside a transaction and rolls back,
so the index is genuinely absent for the measurement and present afterwards.
`SET jit = off` (JIT adds noise to large sequential scans and none to index
lookups). The script ran twice; the second transcript is kept (warm cache).

Full plans and commentary: [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md). Raw
output: [`docs/performance/raw-2026-09-04.txt`](docs/performance/raw-2026-09-04.txt).

```bash
docker compose --profile seed up seed
docker compose exec -T postgres psql -U clinic -d clinic -f /perf/explain-evidence.sql
```

**Environment:** Windows 10 Education (build 19045), Intel Core i7-8750H
(6 cores / 12 threads), 16 GB RAM, Docker Desktop, PostgreSQL 16.15 on Alpine.
Seed load (`npm run seed:reset`) 1,404.9 s wall; `appointments`+notifications
COPY 1,377.7 s.

| # | Index | Named query | Without | Rows filtered | ms | With | ms | Speed-up |
|---|---|---|---|---|---|---|---|---|
| Q1 | `appointments_no_overlap` | taken slots, one doctor, 30 days | Bitmap Heap Scan (via patient GiST) | 71,142 | 277.6 | Bitmap Index Scan (GiST) | 0.6 | 454× |
| Q1b | (btree fallback) | same query, GiST dropped, btree kept | Bitmap Heap Scan | 0 | 251.2 | — | — | — |
| Q2 | `appointments_patient_start_idx` | list my appointments | Parallel Seq Scan | 676,621 | 105.5 | Index Scan Backward (btree) | 0.2 | 507× |
| Q2b | (GiST fallback) | same query, btree dropped | Parallel Seq Scan | 676,621 | 70.3 | — | — | — |
| Q3 | `appointments_doctor_start_at_idx` | monthly analytics aggregate | Parallel Seq Scan | 676,249 | 71.0 | Bitmap Index Scan (btree) | 0.7 | 95× |
| Q4 | `blocks_doctor_id_start_at_end_at_idx` | blocks overlapping a window | Bitmap Heap Scan (GiST) | 19 | 0.1 | Bitmap Index Scan (btree) | 0.1 | 2× |
| Q5 | `waiting_list_slot_status_idx` | FIFO candidates for a freed slot | Index Scan (`one_active`) | 0 | 0.1 | Index Scan (slot+status) | 0.1 | 1.4× |
| Q6 | `waiting_list_one_active` | already in this queue? | Seq Scan | 59,999 | 6.8 | Index Scan (unique partial) | 0.05 | 144× |
| Q7 | `notifications_unique_per_type` | job idempotency lookup | Parallel Seq Scan | 693,884 | 65.3 | Index Scan (unique) | 0.06 | 1,070× |
| Q8 | `notifications_pending_due_idx` | due but unsent reminders | Parallel Seq Scan + sort | 178,719 | 116.6 | Index Scan (partial) | 0.4 | 284× |

### The two that matter most

**Availability over a 30-day window (Q1).** This is the query a patient waits
on. With no doctor-side appointments index, PostgreSQL still finds a
range-capable structure — the *patient* GiST constraint — then discards
**71,142** heap rows that belong to other doctors (**277.6 ms** Bitmap Heap
Scan). With `appointments_no_overlap`, both `doctor_id` equality and the
half-open `tstzrange &&` land in the GiST index condition: **0.6 ms**, 869
confirmed slots, no identity filter waste (**454×**).

The btree on `(doctor_id, start_at)` does **not** substitute. Q1b keeps that
btree, drops the GiST, and still costs **251.2 ms**: the btree narrows to one
doctor, then the overlap predicate bitmaps tens of thousands of rows. The GiST
exclusion index is the availability index, not a side effect of the invariant.

**Monthly analytics for the busiest doctor (Q3).** This query must count
`CANCELLED` rows, so the partial GiST (CONFIRMED only) cannot serve it. Without
the btree: Parallel Seq Scan, **676,249** rows removed, **71.0 ms**. With
`appointments_doctor_start_at_idx`: Bitmap Index Scan on
`(doctor_id, start_at)` for the clinic-local month, **0.7 ms** (**95×**). That
is why a second index exists on the write-heavy table. The same btree also
serves `GET /doctors/:doctorId/appointments`.

### What these numbers do not cover

Write cost on insert. Every index on `appointments` is paid at booking time;
the list is short for that reason. Nothing here quantifies that trade-off.

**Q4 and Q5 are already sub-millisecond without the extra btree** (the GiST
`blocks_no_overlap` and the partial unique `waiting_list_one_active` cover the
lookups). Speed-ups are **2×** and **1.4×** at seed scale — they do not earn
their place on latency today. They stay: blocks are written rarely, the
assignment job's exact `(doctor_id, slot_start_at, status)` predicate belongs
on an index as the waiting list grows, and Q2b shows the opposite mistake
(assuming a constraint index substitutes for a list/sort btree — it does not;
that query still scans ~2M rows).

No measured index was dropped.

## Known limitations and what I would do next

Written as known gaps, not oversights.

**One clinic timezone.** `CLINIC_TZ` is global. Multi-site would need per-doctor
or per-location zones; schedule expansion is the only place that would change.

**Overlapping schedule rows — service layer only.** No PostgreSQL `time` range
type; a custom type + exclusion constraint would close the gap.

**No offer-with-hold on the waiting list.** Direct assignment without re-consent;
first thing to build next ([section 7](#waiting-list-model-and-assumptions)).

**Notifications are rows and log lines.** No email/SMS provider wired.

**Minimal auth.** JWT + three roles; no refresh rotation, password reset, or rate
limiting on `/auth/login`.

**Availability is informational.** A listed slot may be booked before the POST
arrives — correct behaviour; booking has its own DB-level protection.

**Analytics: per doctor, per calendar month only.** No clinic-wide rollup or
caching. At ~2M rows performance is in section 11; at ~20M a materialised rollup
would be next.

**Sweeper ~every minute.** Recovery is bounded to about a minute, not immediate.

**Seed data is synthetic.** Skew is modelled, not taken from a real clinic.

Decision log: [`docs/DECISIONS.md`](docs/DECISIONS.md)

---

## How AI was used

I used an AI coding assistant as a pair programmer against written plans in
`docs/PLANS/`, not as the architect. The decision log, the exclusion-constraint
shape, waiting-list assumptions, and "what this README must prove" stayed with
me. The assistant drafted migrations, Nest modules, tests, and first-pass
prose; I reviewed every diff against the plan and the database.

**What I handed over first, and what I kept.** Schema, CRUD, and test scaffolding
went to the assistant first — they are large and mechanical once the contract is
fixed. Slot expansion in `CLINIC_TZ`, the two GiST constraints, job idempotency
(unique row + conditional `UPDATE`), and the concurrency proof I treated as mine
to specify. Those are the places a confident wrong answer is cheap and expensive
to unwind.

**A concrete prompt, and what I did with the result.** After the concurrency
script first ran, I asked why nine of ten overlapping bookings returned `500`
instead of `409` even though exactly one `CONFIRMED` row existed. The assistant
correctly identified PostgreSQL `40P01` deadlocks on the GiST exclusion check.
The first suggested fix was to map deadlock to `409`. I threw that mapping away:
a deadlock is not proof the slot is taken. The kept change is retry-then-map
`23P01` (decision 19 in [`docs/DECISIONS.md`](docs/DECISIONS.md)).

**One thing it got wrong.** Near the end of the README pass, the assistant
treated `GET /doctors/:doctorId/appointments` as a documentation leftover because
no controller method existed. The contract and `listForDoctor` were already
there; the HTTP route had never been registered. A doctor literally could not
read their calendar. I noticed it only by reading the README against the
controllers. The route is in place now, with ownership tests.

Smaller misses in the same class: seed hashing against `bcrypt` while the app
uses `bcryptjs`; plan index names that do not match the live schema
(`appointments_patient_start_idx`, not `…_start_at_idx`); Compose commands
written as if `docker-compose.yml` lived inside `clinic_appointment_booking/`.
None of those fail a unit test. All of them fail a reviewer who follows the
README.

**Where it saved the most time.** The analytics SQL (CTEs, `range_agg` before
block subtraction, clinic-local month bounds) and the COPY seed pipeline
(deterministic RNG, occupancy so generated rows never overlap, 50k-row
transactions with constraints on). Roughly two to three hours on analytics and
a similar amount on seed/EXPLAIN harness that I would have spent in `psql`
trial-and-error. Nest module wiring and e2e boilerplate were cheaper still, but
less load-bearing.

**A suggestion I rejected.** A unique index on `(doctor_id, start_at)` as the
booking invariant. It catches identical starts and misses overlap when slot
duration varies. Redis distributed locks and advisory locks were rejected for
the same reason the README gives: they only protect code paths that remember to
take them. Direct waiting-list assignment without offer-with-hold was *my*
call, against the more clinic-like hold window the assistant was happy to
design — the extra state machine is not what this task is grading.

**A README decision that was mine.** Workers as a separate Compose service, not
in-process with the API. Scaling HTTP replicas must not silently double job
concurrency. Redis with no volume is the same family of choice: it is a
scheduler, PostgreSQL is the record.

**How I verified generated code**

I didn't trust generated code on sight. I verified the important invariants in three ways:

1. **Schema integrity** — I used real database migrations and kept `synchronize: false`.
The database schema is therefore explicit, reviewable, and reproducible.

2. **Concurrency correctness** — I tested the booking flow with nginx and two application replicas,
issuing concurrent requests for the same slot. The invariant is that only one booking succeeds;
the competing request must receive `409 Conflict`, rather than simply asserting that it did not return `201`.

3. **Index effectiveness** — I used `EXPLAIN ANALYZE` against a dataset of
roughly 2 million appointments and compared query plans with and without the relevant indexes.
I tested index changes safely inside a transaction where appropriate.

If I'm asked to walk through a file, I start from the test that expresses the invariant, then trace that requirement to the database constraint or conditional `UPDATE` that enforces it.


**Without AI** The Task would have taken about 2 weeks to finish 