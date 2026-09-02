# Availability

## Goal

Allow patients to list available appointment slots for a doctor over a date range.

---

# Endpoint Behavior

Input:

- doctor id
- start date
- end date

Output:

Available appointment slots.

---

# Slot Generation

For each requested date:

1. Find doctor's weekly schedule rows for that weekday.
2. Generate slots from each matching schedule using that row's slot duration.
3. Remove slots overlapping blocked periods.
4. Remove slots already occupied by confirmed appointments.
5. Return remaining slots.

Slot generation is a **pure function** — schedule rows, blocks and booked ranges
in, slot list out. It performs no database access and is the primary unit-test
surface in the project. The repository fetches the inputs; the generator decides.

---

# Timezone Handling

Schedules are wall-clock (`day_of_week`, `start_time`); appointments are absolute
instants (`timestamptz`). The conversion between them happens here and nowhere
else.

Decided approach:

1. Read the clinic timezone from `CLINIC_TZ` (for example `Africa/Cairo`).
2. Walk the requested date range as clinic-local calendar dates.
3. For each date, take the weekday and expand matching schedule rows into
   clinic-local slot boundaries.
4. Convert each slot boundary to UTC, then compare against blocks and
   appointments, which are already stored in UTC.

Why this matters: a schedule row saying "Sunday 10:00" maps to a *different* UTC
instant depending on whether daylight saving is in effect. Expanding schedules
directly in UTC produces slots that drift by an hour for part of the year. It
does not crash and it is very hard to notice in a demo.

Slot boundaries are half-open intervals, `[start_at, end_at)`. A slot ending at
10:30 and one starting at 10:30 do not overlap. This matches the `'[)'` range
bound used by the `appointments_no_overlap` constraint, and the two must agree.

Multi-timezone clinics are out of scope and documented as a limitation.

---

# Example

Schedule:

10:00 → 12:00

Duration:

30 minutes

Generated slots:

10:00 → 10:30
10:30 → 11:00
11:00 → 11:30
11:30 → 12:00

If:

10:30 is booked

Return:

10:00 → 10:30
11:00 → 11:30
11:30 → 12:00

---

# Performance

The system may contain approximately 2 million appointments.

Do not load all appointments for a doctor/month into JavaScript unnecessarily.

Queries should be scoped by:

doctor_id
date/time range
status

Use indexes that support those predicates.

---

# Date Range

Validate that:

start_date <= end_date

Decided: the maximum range is 62 days, rejected with 400 beyond that. This covers
the realistic "browse the next two months" case while bounding the work per
request, since slot generation is linear in the number of days.

Dates are interpreted as clinic-local calendar dates, not UTC dates.

---

# Consistency

Availability is informational.

A slot returned as available may be booked by another patient before the booking request arrives.

The booking endpoint must always perform its own database-level concurrency protection.

Never assume availability results reserve a slot.