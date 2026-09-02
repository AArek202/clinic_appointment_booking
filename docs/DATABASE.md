# Database Design

PostgreSQL is the source of truth for appointment availability.

The database must protect important business invariants even when multiple application instances are running.

---

# Naming Conventions

Decided conventions, applied consistently across entities, migrations and queries:

- Instant columns (`timestamptz`) are named `*_at`, for example `start_at`, `end_at`, `cancelled_at`.
- Wall-clock columns (`time`) are named `*_time`, for example `start_time`, `end_time`.
- Use the spelling `cancelled` (double `l`) everywhere: enum values, column names, code.

---

# Timezone Strategy

Decided: the clinic operates in a single timezone, supplied by the `CLINIC_TZ`
environment variable (for example `Africa/Cairo`).

- `schedules` stores wall-clock time (`day_of_week`, `start_time`, `end_time`). It carries no timezone.
- `blocks` and `appointments` store absolute instants as `timestamptz` (UTC).
- Conversion happens in exactly one place in the application: schedule expansion.
  Slots are generated in clinic-local time, then converted to UTC for storage and comparison.

This is DST-correct for one clinic. Multi-timezone clinics are explicitly out of
scope and documented as a limitation in the README.

---

# Main Tables

## users

Stores authentication information.

Fields should include:

- id
- first_name
- last_name
- email
- password_hash
- role
- created_at
- updated_at

Roles:

- ADMIN
- PATIENT
- DOCTOR

---

## doctors

Represents doctors.

Fields should include:

- id
- user_id (FK to Users table -> UNIQUE)
- specialization
- achievements

---

## patients

Represents Patients

Fields should include:

- id
- user_id (FK to Users table -> UNIQUE)
- phone_number
- date_of_birth
- gender

---

## schedules

Represents weekly recurring working hours.

A schedule should contain:

- id
- doctor_id
- day_of_week
- start_time
- end_time
- slot_duration_minutes

`day_of_week` uses **0 = Sunday** through **6 = Saturday**, matching PostgreSQL's
`EXTRACT(DOW FROM date)`.

This is not a free choice. The analytics capacity query joins schedules to
generated dates with `s.day_of_week = EXTRACT(DOW FROM d.day)`, so any other
convention (for example ISO 1 = Monday) would shift every schedule by one day
while still looking internally consistent. The column carries a comment in the
migration saying so, and a `CHECK (day_of_week BETWEEN 0 AND 6)`.

Allowed slot durations:

- 15
- 30
- 60

---

## blocks

Represents dates/times when a doctor is unavailable. The cause may be planned,
such as a vacation day, or unexpected — a personal or family emergency, an urgent
hospital case, illness, an urgent work commitment, or anything else that stops
the doctor attending appointments.

A block prevents new bookings inside it. It does not alter appointments that were
already confirmed.

Fields should allow representing:

- id
- doctor_id
- start_at
- end_at
- reason

Example:

Sunday 00:00 -> Monday 00:00
reason: vacation

Monday 10:00 -> 11:30
reason: emergency

A doctor's blocks may not overlap each other: one period of unavailability is one
row. Enforced by `blocks_no_overlap` under "Database Constraints" below, not by
an application check. Adjacent blocks are fine — the range bound is half-open, so
10:00–11:00 followed by 11:00–12:00 is accepted.

---

## appointments

Represents patient bookings.

Important fields:

- id
- doctor_id
- patient_id
- start_at
- end_at
- status
- created_from
- created_at
- updated_at
- cancelled_at

Statuses:

- CONFIRMED
- CANCELLED

`created_from` records how the appointment came to exist:

- DIRECT (default) — a patient booked it through the booking endpoint
- WAITING_LIST — a background job assigned it from the waiting list

It costs one column and makes waiting-list assignment provable in the database
during the demo, rather than only visible in logs.

---

## waiting_list

Represents patients waiting for an occupied slot.

Fields should include:

- id
- doctor_id
- patient_id
- slot_start_at
- slot_end_at
- status
- expires_at (nullable)
- created_at
- updated_at

Statuses:

- WAITING
- ASSIGNED
- EXPIRED
- CANCELLED

The slot is identified by `(doctor_id, slot_start_at)` — the same identity the
appointments table uses. `slot_end_at` is stored so the assignment job can create
the appointment without re-reading the schedule, which matters because the
schedule's slot duration may have changed since the patient joined the queue.

Queue order is FIFO by `created_at`. No `position` column is stored, because a
position column would need renumbering on every removal for no benefit.

---

## notifications

Used to make background-job behavior observable, and to make jobs idempotent.

Fields should include:

- id
- appointment_id
- patient_id
- type
- scheduled_at
- sent_at (nullable)
- status
- created_at

Types:

- REMINDER
- WAITLIST_ASSIGNED

Statuses:

- PENDING
- SENT

This replaces the earlier separate `reminders` table. Both job types need the
same "have we already done this?" check, so they share one table, one unique
constraint and one atomic status transition instead of duplicating that logic.

---

# Indexing

The project assumes approximately:

- 200 doctors
- 2 million appointments

Indexes should support the most common queries. Each index below exists for a
named query.

appointments:

- The `appointments_no_overlap` exclusion constraint (see below) creates a GiST
  index on `(doctor_id, tstzrange(start_at, end_at))` restricted to CONFIRMED
  rows. This index serves two purposes: it enforces the booking invariant, and
  it answers "which slots are taken for this doctor in this date range?" for the
  availability endpoint. One index, two jobs.
- `(patient_id, start_at)` — "list my appointments", and the ownership check on cancel.
- `(doctor_id, start_at)` including cancelled rows — the monthly analytics query,
  which must count cancelled appointments and therefore cannot use the partial index.

blocks:

- `(doctor_id, start_at, end_at)` — subtracting blocked periods during slot generation.
- The `blocks_no_overlap` exclusion constraint (see below) also creates a GiST
  index on `(doctor_id, tstzrange(start_at, end_at))`. It exists for the
  invariant; the btree above is what the range lookup is measured against.

waiting_list:

- `(doctor_id, slot_start_at, status)` — the assignment job finding waiting
  entries for a freed slot, and the sweeper scanning for stranded entries.
- `(doctor_id, patient_id, slot_start_at) WHERE status = 'WAITING'` — unique,
  doubles as the "already in this queue" lookup.

notifications:

- `(appointment_id, type)` — unique, doubles as the idempotency lookup.
- `(scheduled_at) WHERE status = 'PENDING'` — the reconciliation sweeper
  finding due-but-unsent notifications. `status` is a constant under the
  partial predicate, so it is not in the key; including it would only make
  the index larger.

Index choices must be justified with `EXPLAIN ANALYZE` output against a seeded
dataset of roughly 200 doctors and 2 million appointments, and that output goes
in the README. An index without a measured query does not belong in the schema.

Note the trade-off: `appointments` is the write-heavy table, and every additional
index is a cost on insert. The list above is deliberately short for that reason.

---

# Database Constraints

Important invariants are protected at database level. Application checks exist
for user-friendly error messages; they are never the only protection.

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- appointments: no overlapping confirmed appointments for the same doctor
ALTER TABLE appointments ADD CONSTRAINT appointments_time_valid
  CHECK (end_at > start_at);

ALTER TABLE appointments ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (
    doctor_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (status = 'CONFIRMED');

-- appointments: a patient cannot hold two overlapping appointments either
ALTER TABLE appointments ADD CONSTRAINT appointments_patient_no_overlap
  EXCLUDE USING gist (
    patient_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (status = 'CONFIRMED');

-- waiting_list: one active entry per patient per slot
CREATE UNIQUE INDEX waiting_list_one_active
  ON waiting_list (doctor_id, patient_id, slot_start_at)
  WHERE status = 'WAITING';

-- notifications: one of each type per appointment, ever
ALTER TABLE notifications ADD CONSTRAINT notifications_unique_per_type
  UNIQUE (appointment_id, type);

-- schedules: valid duration and coherent window
ALTER TABLE schedules ADD CONSTRAINT schedules_slot_duration_valid
  CHECK (slot_duration_minutes IN (15, 30, 60));

ALTER TABLE schedules ADD CONSTRAINT schedules_time_valid
  CHECK (start_time < end_time);

-- blocks: coherent window
ALTER TABLE blocks ADD CONSTRAINT blocks_time_valid
  CHECK (end_at > start_at);

-- blocks: one period of unavailability per row, per doctor
ALTER TABLE blocks ADD CONSTRAINT blocks_no_overlap
  EXCLUDE USING gist (
    doctor_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  );
```

Two details that matter:

The range bound is `'[)'` — half-open. Start is inclusive, end is exclusive. With
inclusive-inclusive bounds, back-to-back slots such as 10:00–10:30 and 10:30–11:00
would be treated as overlapping and every consecutive booking would be rejected.

The two **appointment** exclusion constraints are partial
(`WHERE status = 'CONFIRMED'`). Cancelled rows are retained for analytics and
must not block rebooking of the same slot. `blocks_no_overlap` is not partial:
`blocks` has no status column, and removing a block is a real delete.

All three exclusion constraints are **named distinctly on purpose**. They raise
the same SQLSTATE, `23P01`, and mean different things:

- `appointments_no_overlap` — the doctor's slot is taken. The booking failed and
  no retry will help.
- `appointments_patient_no_overlap` — this patient is busy elsewhere at that
  time. The slot itself may still be free.
- `blocks_no_overlap` — the doctor already has a block covering part of that
  period. Nothing about appointments is involved.

The error handler and the waiting-list job both branch on the constraint name.
See `docs/INFRASTRUCTURE/Concurrency.md`.

The patient constraint also gives the `(patient_id, ...)` GiST index, which
serves the "do I already have something then?" pre-check.

## Known gap: overlapping schedule rows

PostgreSQL has no built-in range type over `time`, so preventing two overlapping
`schedules` rows on the same weekday cannot use an exclusion constraint without
defining a custom range type. That validation lives in the service layer instead.
This is a deliberate, documented gap rather than an oversight.

Note that `blocks` has the same shape of rule and does **not** share the gap:
those columns are `timestamptz`, `tstzrange` exists, and `blocks_no_overlap`
enforces it in the database. The gap is a limitation of the `time` type, not a
preference for validating in the service layer.

---

# Migrations

Every schema change must have a migration.

Do not use synchronize=true.

Migrations should be committed to Git.