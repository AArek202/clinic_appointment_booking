# Database Design

PostgreSQL is the source of truth for appointment availability.

The database must protect important business invariants even when multiple application instances are running.

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
- has_insurance (ENUM: true | false -> default: false)

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

Allowed slot durations:

- 15
- 30
- 60

---

## blocks

Represents unavailable dates/times.

Examples:

- full vacation day
- emergency

Fields should allow representing:

- id
- doctor_id
- start_at
- end_at
- reason

Example:

Sunday
00:00 -> 00:00
reason: vacation

Monday
10:00 -> 11:30
reason: emergency

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
- created_at
- updated_at
- canceled_at

Statuses:

- CONFIRMED
- CANCELLED

---

## waiting_list

Represents patients waiting for an occupied slot.

Fields should include:

- id
- doctor_id
- patient_id
- appointment_starts_at
- created_at
- status

Statuses:

- Waiting
- Assigned
- Expired
- Canceled

---

## reminders

Used to make background-job behavior observable.

Fields can include:

- id
- appointment_id
- patient_id
- sceduled_at
- sent_at
- status

Statuses:

- Sent
- Pending

This table is useful for making reminder jobs idempotent.

---

# Indexing

The project assumes approximately:

- 200 doctors
- 2 million appointments

Indexes should support the most common queries.

At minimum consider:

appointments:

- doctor_id + start_datetime
- patient_id + start_datetime
- doctor_id + status + start_datetime

blocked_periods:

- doctor_id + start_datetime + end_datetime

waiting_list:

- doctor_id + start_datetime + status
- slot identity + position

The exact indexes may be adjusted after reviewing the actual queries.

Every index should have a reason documented in the README.

Do not create indexes without a query/use case.

---

# Database Constraints

Important invariants should be protected at database level.

The system must prevent two confirmed appointments from occupying the same doctor's slot.

The preferred solution should use a PostgreSQL constraint/index rather than relying only on application-level checks.

Application checks are useful for user-friendly error messages, but they are not sufficient for concurrency protection.

---

# Migrations

Every schema change must have a migration.

Do not use synchronize=true.

Migrations should be committed to Git.