# Doctor Monthly Analytics

## Goal

Provide monthly analytics for a specific doctor.

Input:

- doctor id
- year
- month

---

# Required Metrics

Return:

1. Total appointments
2. Cancellation rate
3. Peak booking hours
4. Average schedule utilization

---

# SQL Requirement

The calculations MUST happen in PostgreSQL.

Do NOT:

```ts
const appointments = await repository.find(...);

const total = appointments.length;
```
and calculate the metrics in JavaScript.

Use:

- raw SQL
- TypeORM QueryBuilder

---

# Total Appointments

Count appointments for the doctor during the requested month.

Clarify in implementation whether total appointments means:

- all created appointments
- confirmed appointments
- confirmed + cancelled

The chosen definition must be documented.

Recommended:

Total appointments = all appointments created for the doctor during the month.

---

# Cancellation Rate

Recommended:

cancelled appointments / total appointments * 100

If total appointments = 0:

return 0.

---

# Peak Booking Hours

Group appointments by hour of appointment start time.

Example:

10:00 → 15 appointments
11:00 → 24 appointments
12:00 → 18 appointments

Peak:

11:00

If multiple hours tie, return all tied hours.

---

# Schedule Utilization

Recommended definition:

booked appointment minutes

available scheduled minutes

Multiply by 100 for percentage.

Available scheduled minutes should account for:

- weekly schedule
- blocked periods

Document the exact definition.

---

# Performance

The analytics query should operate in PostgreSQL.

Avoid returning millions of rows to the application.

Use aggregation functions such as:

COUNT
SUM
AVG
GROUP BY
CASE
date/time functions

as appropriate.