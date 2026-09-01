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

Avoid accepting unnecessarily large date ranges.

The API should enforce a sensible maximum range if appropriate.

---

# Consistency

Availability is informational.

A slot returned as available may be booked by another patient before the booking request arrives.

The booking endpoint must always perform its own database-level concurrency protection.

Never assume availability results reserve a slot.