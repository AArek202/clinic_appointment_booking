\set ON_ERROR_STOP on

-- Measure the busiest doctor, not an average one (docs/TESTING.md).
SELECT a.doctor_id::text AS busiest
FROM appointments a
GROUP BY a.doctor_id
ORDER BY COUNT(*) DESC
LIMIT 1
\gset

\echo 'Busiest doctor id:' :busiest

EXPLAIN (ANALYZE, BUFFERS)
WITH params AS (
  SELECT
    :'busiest'::uuid AS doctor_id,
    'Africa/Cairo'::text AS tz,
    (make_date(2024, 3, 1)::timestamp AT TIME ZONE 'Africa/Cairo') AS month_start,
    ((make_date(2024, 3, 1) + INTERVAL '1 month')::timestamp AT TIME ZONE 'Africa/Cairo') AS month_end
),
stats AS (
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
  SELECT array_agg(h.hour ORDER BY h.hour) AS peak_hours
  FROM hourly h
  WHERE h.bookings = (SELECT MAX(h2.bookings) FROM hourly h2)
),
days AS (
  SELECT (p.month_start AT TIME ZONE p.tz)::date + offset_days AS day
  FROM params p,
       generate_series(
         0,
         ((p.month_end AT TIME ZONE p.tz)::date - (p.month_start AT TIME ZONE p.tz)::date) - 1
       ) AS offset_days
),
windows AS (
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
  SELECT COALESCE(
           SUM(EXTRACT(EPOCH FROM (upper(free.part) - lower(free.part))) / 60),
           0
         ) AS available_minutes
  FROM windows w
  CROSS JOIN blocked bl
  CROSS JOIN LATERAL unnest(tstzmultirange(w.win) - bl.ranges) AS free(part)
)
SELECT
  s.total::int AS total_appointments,
  COALESCE(ROUND(100.0 * s.cancelled / NULLIF(s.total, 0), 2), 0) AS cancellation_rate,
  COALESCE(pk.peak_hours, '{}'::int[]) AS peak_hours,
  COALESCE(ROUND(100.0 * s.booked_minutes / NULLIF(c.available_minutes, 0), 2), 0) AS utilization_rate
FROM stats s, peak pk, capacity c;
