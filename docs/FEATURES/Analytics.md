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

Decided: total appointments = every appointment whose `start_at` falls in the
requested month, regardless of status (CONFIRMED + CANCELLED).

The month is bounded in clinic-local time and converted to UTC, so the range is
`[first day 00:00 CLINIC_TZ, first day of next month 00:00 CLINIC_TZ)` expressed
as `timestamptz`. Using UTC month boundaries would mis-bucket appointments near
midnight.

Because the query must count cancelled rows, it cannot use the partial index that
covers only CONFIRMED rows — hence the separate `(doctor_id, start_at)` index.

---

# Cancellation Rate

Decided:

cancelled appointments / total appointments * 100

If total appointments = 0, return 0. Guard the division in SQL with
`COALESCE(... / NULLIF(total, 0), 0)` — `NULLIF` alone avoids the
division-by-zero but yields `NULL` rather than the zero promised here.

---

# Peak Booking Hours

Decided: group by the **hour of the appointment's start time**, in clinic-local
time, not by the hour the booking was created.

The task's phrase "peak booking hours" is ambiguous. The chosen reading answers
the question the clinic actually cares about — which hours of the working day are
busiest — rather than when patients happen to use the app. The alternative
reading (hour of `created_at`) is noted in the README as a deliberate choice.

Example:

10:00 → 15 appointments
11:00 → 24 appointments
12:00 → 18 appointments

Peak:

11:00

If multiple hours tie, return all tied hours.

---

# Schedule Utilization

Decided definition, minutes-based:

booked confirmed minutes / available scheduled minutes * 100

Available scheduled minutes accounts for:

- the recurring weekly schedule, expanded across the requested month
- blocked periods subtracted from it

## Why minutes and not slot counts

The denominator does not exist as rows anywhere — capacity is a recurring weekly
pattern that has to be expanded over a specific month, in SQL. Summing interval
durations per schedule row is materially simpler than generating every individual
slot with a nested `generate_series`, and it produces the same ratio.

Approach: `generate_series` over the month's days, joined to `schedules` on
`EXTRACT(DOW FROM day)`, summing `end_time - start_time` per matching day, minus
the intersection of `blocks` with those working windows. Booked minutes come from
summing `end_at - start_at` over CONFIRMED appointments in the same range.

## Documented edge cases

- A block that only partially covers a working window subtracts only the
  overlapping portion. Because blocks are first merged into a **multirange**
  (see below), the subtraction is `tstzmultirange(win) - merged_blocks`, whose
  remaining parts are summed. The plain range intersection operator `*` does not
  accept a multirange on the right, so it cannot be used here.
- A block outside working hours subtracts nothing.
- If available scheduled minutes = 0 (doctor has no schedule that month),
  utilization is 0, not an error.
- Cancelled appointments do not count as booked minutes, but they do count toward
  total appointments. The two metrics deliberately use different filters.

---

# Query Implementation

One raw SQL query, one round trip, assembled from CTEs where each CTE has a
single job. Parameters: doctor id, year, month, `CLINIC_TZ`.

## Month boundaries

```sql
WITH params AS (
  SELECT $1::uuid AS doctor_id,
         $4::text AS tz,
         (make_date($2, $3, 1)::timestamp AT TIME ZONE $4) AS month_start,
         ((make_date($2, $3, 1) + INTERVAL '1 month')::timestamp AT TIME ZONE $4) AS month_end
)
```

`AT TIME ZONE` runs in both directions and the direction depends on the input type:

- applied to a naive `timestamp`, it reads that value **as** clinic time and
  returns a `timestamptz`
- applied to a `timestamptz`, it returns the naive local `timestamp` in that zone

Both directions are used in this query. Confusing them is the standard way this
kind of query goes subtly wrong — the result still looks plausible, just shifted.

## Totals, cancellation rate, booked minutes

```sql
stats AS (
  SELECT COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
         COALESCE(SUM(EXTRACT(EPOCH FROM (end_at - start_at)) / 60)
                  FILTER (WHERE status = 'CONFIRMED'), 0) AS booked_minutes
  FROM appointments a, params p
  WHERE a.doctor_id = p.doctor_id
    AND a.start_at >= p.month_start
    AND a.start_at <  p.month_end
)
```

`FILTER` rather than three separate scans: total counts every status, booked
minutes count only CONFIRMED. The two metrics deliberately use different filters,
and expressing that in one pass keeps it obvious that they read the same rows.

## Peak hours

```sql
hourly AS (
  SELECT EXTRACT(HOUR FROM (a.start_at AT TIME ZONE p.tz))::int AS hour,
         COUNT(*) AS bookings
  FROM appointments a, params p
  WHERE a.doctor_id = p.doctor_id
    AND a.start_at >= p.month_start AND a.start_at < p.month_end
    AND a.status = 'CONFIRMED'
  GROUP BY 1
),
peak AS (
  SELECT array_agg(hour ORDER BY hour) AS peak_hours
  FROM hourly
  WHERE bookings = (SELECT MAX(bookings) FROM hourly)
)
```

Grouping on the **local** hour, because "the 10am slot is busiest" is a statement
about clinic time. Comparing against `MAX` rather than `ORDER BY ... LIMIT 1` is
what returns all tied hours.

## Capacity

This is the only part with no rows to read — capacity is a recurring weekly
pattern that has to be expanded over a concrete month.

```sql
days AS (
  SELECT d::date AS day
  FROM params p,
       generate_series((p.month_start AT TIME ZONE p.tz)::date,
                       ((p.month_end AT TIME ZONE p.tz) - INTERVAL '1 day')::date,
                       INTERVAL '1 day') AS d
),
windows AS (
  SELECT tstzrange((d.day + s.start_time)::timestamp AT TIME ZONE p.tz,
                   (d.day + s.end_time)::timestamp   AT TIME ZONE p.tz, '[)') AS win
  FROM days d
  CROSS JOIN params p
  JOIN schedules s ON s.doctor_id = p.doctor_id
                  AND s.day_of_week = EXTRACT(DOW FROM d.day)
)
```

Note the join condition: `EXTRACT(DOW)` returns **0 for Sunday**, so
`schedules.day_of_week` must use the same convention. See the constraint in
`docs/DATABASE.md`. Storing 1 = Monday would put every schedule one day out, and
availability would still look internally consistent.

Each schedule row becomes one concrete UTC window per matching day. Summing
window durations gives gross capacity without generating individual slots — the
ratio is the same and there is far less to reason about.

## Subtracting blocks, without double-counting

```sql
blocked AS (
  SELECT range_agg(tstzrange(b.start_at, b.end_at, '[)')) AS ranges
  FROM blocks b, params p
  WHERE b.doctor_id = p.doctor_id
    AND b.start_at < p.month_end
    AND b.end_at   > p.month_start
)
```

Blocks are merged into a single multirange **before** being subtracted.

The failure this avoids is subtracting the same minute twice: intersecting each
block with the window separately double-counts any time two blocks share, and
utilization can then exceed 100% or go negative.

A doctor's blocks cannot overlap — `blocks_no_overlap` rejects that at write time
(`docs/DECISIONS.md` #18) — so no legal row can trigger it. The merge stays
anyway, because `range_agg` plus multirange difference is one operator that is
structurally incapable of subtracting a minute twice. It costs nothing, and it
does not quietly depend on a constraint elsewhere in the schema staying in place.

Each window intersects the merged multirange, and the intersection's duration is
subtracted from that window's duration. Partial overlaps therefore subtract only
the overlapping portion, and blocks outside working hours subtract nothing.

`range_agg` and multirange types require **PostgreSQL 14 or newer**. Compose pins
PostgreSQL 16.

## Final assembly

Divisions are guarded with `NULLIF` **wrapped in `COALESCE`**, so a month with no
appointments or no schedule returns zeros rather than raising a
division-by-zero:

```sql
SELECT s.total,
       COALESCE(ROUND(100.0 * s.cancelled / NULLIF(s.total, 0), 2), 0)
         AS cancellation_rate,
       COALESCE(pk.peak_hours, '{}') AS peak_hours,
       COALESCE(ROUND(100.0 * s.booked_minutes / NULLIF(c.available_minutes, 0), 2), 0)
         AS utilization_rate
FROM stats s, peak pk, capacity c
```

`NULLIF` alone is not enough. It prevents the error by turning the divisor into
`NULL`, but then the whole expression evaluates to `NULL`, not `0` — so an
untouched `NULLIF` would return `null` rates for a quiet month and the API would
have to special-case them. `COALESCE` is what actually delivers the zero this
document promises.

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