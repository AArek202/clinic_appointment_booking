# Doctor Schedules

## Goal

Doctors have recurring weekly working schedules.

Example:

Sunday → Thursday
10:00 → 16:00

---

# Schedule

A schedule contains:

- doctor
- weekday
- start time
- end time
- slot_duration_minutes

Allowed slot durations:

- 15
- 30
- 60

Different schedule rows for the same doctor may use different durations (for example 30 minutes on Sunday and 15 minutes on Monday).

---

# Requirements

A doctor can create, update, remove and view their **own** schedule.

An ADMIN can do the same for **any** doctor.

Both go through the same ownership rule described in `docs/FEATURES/Auth.md`:
the caller is ADMIN, or the caller is the doctor being addressed.

---

# Rules

start_time must be before end_time.

Overlapping schedules for the same doctor/day should not be allowed.

Availability must be generated from:

weekly schedule (including that row's slot duration)
-
blocked periods
-
existing appointments

Changing a schedule's slot duration must not modify historical appointments.

Historical appointments retain their original start/end times.

Availability and new bookings use the duration on the matching schedule row.

---

# Date Handling

Decided: a single clinic timezone from the `CLINIC_TZ` environment variable.

- Schedule rows store wall-clock `time` values with no timezone.
- Appointments and blocks store `timestamptz` (UTC).
- Conversion happens only during schedule expansion, described in
  `docs/FEATURES/Availability.md`.

Do not mix local server time and UTC implicitly. Server local time is never used
for business logic — `CLINIC_TZ` is, so behaviour does not change with the host.

---

# Consequence for the Booking Constraint

Because slot duration lives on each schedule row, may differ per weekday, and may
change without rewriting historical appointments, a doctor can hold a 30-minute
appointment while their schedule has since moved to 15-minute slots.

This is exactly why the booking invariant is enforced with an overlap exclusion
constraint rather than a unique index on `start_at`. See
`docs/INFRASTRUCTURE/Concurrency.md`.

Overlapping schedule rows for the same doctor/day are rejected in the service
layer, because PostgreSQL has no built-in range type over `time`.