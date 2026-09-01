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

Doctor can:

- create schedule
- update schedule
- remove schedule
- view schedule

Doctor can only modify their own schedule.

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

The API must define one timezone strategy.

Use a consistent timezone for schedule calculations and document it in the README.

Do not mix local server time and UTC implicitly.

All persisted appointment timestamps should use PostgreSQL timestamp semantics consistently.