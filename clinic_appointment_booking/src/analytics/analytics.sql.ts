/**
 * Doctor monthly analytics, computed entirely inside PostgreSQL.
 *
 * Parameters:
 *   $1  doctor id       uuid
 *   $2  year            int
 *   $3  month           int, 1-12
 *   $4  clinic timezone IANA name, e.g. 'Africa/Cairo'
 *
 * Always returns exactly one row: `stats`, `peak` and `capacity` are each
 * single-row aggregates, so the three-way cross join at the bottom cannot
 * produce zero rows even for a doctor id that does not exist.
 *
 * Requires PostgreSQL 14 or newer for `range_agg`, multirange types and
 * `unnest(anymultirange)`. Compose pins 16 (docs/INFRASTRUCTURE/Deployment.md).
 *
 * Walkthrough: docs/PLANS/08-analytics.md, "Query Walkthrough".
 */
export const DOCTOR_MONTHLY_ANALYTICS_SQL = `
WITH params AS (
  -- Month boundaries in CLINIC-LOCAL time, converted to UTC instants.
  -- AT TIME ZONE applied to a naive timestamp reads it AS clinic time and
  -- returns a timestamptz. Using UTC boundaries here would mis-bucket every
  -- appointment near local midnight on the first and last day of the month.
  SELECT
    $1::uuid AS doctor_id,
    $4::text AS tz,
    (make_date($2::int, $3::int, 1)::timestamp AT TIME ZONE $4::text) AS month_start,
    ((make_date($2::int, $3::int, 1) + INTERVAL '1 month')::timestamp AT TIME ZONE $4::text) AS month_end
),

stats AS (
  -- One scan, three numbers. FILTER is what lets total count every status
  -- while booked_minutes counts only CONFIRMED rows.
  SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE a.status = 'CANCELLED') AS cancelled,
    COALESCE(
      SUM(EXTRACT(EPOCH FROM (a.end_at - a.start_at)) / 60)
        FILTER (WHERE a.status = 'CONFIRMED'),
      0
    ) AS booked_minutes
  FROM appointments a, params p
  WHERE a.doctor_id = p.doctor_id
    AND a.start_at >= p.month_start
    AND a.start_at <  p.month_end
),

hourly AS (
  -- AT TIME ZONE applied to a timestamptz runs the other way and yields the
  -- naive local time, so this groups by the clinic's hour, not UTC's.
  SELECT
    EXTRACT(HOUR FROM (a.start_at AT TIME ZONE p.tz))::int AS hour,
    COUNT(*) AS bookings
  FROM appointments a, params p
  WHERE a.doctor_id = p.doctor_id
    AND a.start_at >= p.month_start
    AND a.start_at <  p.month_end
    AND a.status = 'CONFIRMED'
  GROUP BY 1
),

peak AS (
  -- Comparing against MAX, rather than ORDER BY ... LIMIT 1, is what returns
  -- every tied hour instead of an arbitrary one of them.
  SELECT array_agg(h.hour ORDER BY h.hour) AS peak_hours
  FROM hourly h
  WHERE h.bookings = (SELECT MAX(h2.bookings) FROM hourly h2)
),

days AS (
  -- One row per calendar day of the clinic-local month. An integer series
  -- keeps the generate_series overload unambiguous and the arithmetic plain:
  -- day 0 through day (days-in-month - 1).
  SELECT (p.month_start AT TIME ZONE p.tz)::date + offset_days AS day
  FROM params p,
       generate_series(
         0,
         ((p.month_end AT TIME ZONE p.tz)::date - (p.month_start AT TIME ZONE p.tz)::date) - 1
       ) AS offset_days
),

windows AS (
  -- Capacity has no rows of its own: it is a weekly pattern expanded over a
  -- concrete month. Each schedule row becomes one UTC window per matching day.
  -- EXTRACT(DOW) returns 0 for Sunday, which is why schedules.day_of_week must
  -- use 0 = Sunday (docs/DATABASE.md). Half-open '[)' bounds, as everywhere.
  SELECT tstzrange(
           (d.day + s.start_time) AT TIME ZONE p.tz,
           (d.day + s.end_time)   AT TIME ZONE p.tz,
           '[)'
         ) AS win
  FROM days d
  CROSS JOIN params p
  JOIN schedules s
    ON s.doctor_id = p.doctor_id
   AND s.day_of_week = EXTRACT(DOW FROM d.day)::int
),

blocked AS (
  -- Every block touching the month, merged into ONE multirange before it is
  -- subtracted. Subtracting block by block would take any shared minute off
  -- twice and utilization could exceed 100% or go negative. blocks_no_overlap
  -- makes such a pair unstorable; the merge means the query does not depend on
  -- that. range_agg over zero rows returns NULL, hence the COALESCE.
  SELECT COALESCE(
           range_agg(tstzrange(b.start_at, b.end_at, '[)')),
           '{}'::tstzmultirange
         ) AS ranges
  FROM blocks b, params p
  WHERE b.doctor_id = p.doctor_id
    AND b.start_at < p.month_end
    AND b.end_at   > p.month_start
),

capacity AS (
  -- Multirange difference is set difference, so it can never remove more time
  -- than the window contains. A partial overlap leaves the rest of the window,
  -- a block outside working hours removes nothing, and a fully blocked window
  -- yields zero rows and therefore zero minutes.
  SELECT COALESCE(
           SUM(EXTRACT(EPOCH FROM (upper(free.part) - lower(free.part))) / 60),
           0
         ) AS available_minutes
  FROM windows w
  CROSS JOIN blocked bl
  CROSS JOIN LATERAL unnest(tstzmultirange(w.win) - bl.ranges) AS free(part)
)

-- NULLIF turns a zero denominator into NULL instead of an error; COALESCE is
-- what turns that NULL into the documented 0.
SELECT
  s.total::int                                                          AS total_appointments,
  COALESCE(ROUND(100.0 * s.cancelled / NULLIF(s.total, 0), 2), 0)       AS cancellation_rate,
  COALESCE(pk.peak_hours, '{}'::int[])                                  AS peak_hours,
  COALESCE(ROUND(100.0 * s.booked_minutes / NULLIF(c.available_minutes, 0), 2), 0)
                                                                        AS utilization_rate
FROM stats s, peak pk, capacity c
`;
