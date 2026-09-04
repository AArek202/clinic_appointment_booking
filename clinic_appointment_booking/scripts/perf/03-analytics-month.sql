\echo ''
\echo '=========================================================================='
\echo 'Q3  Monthly analytics aggregate for one doctor'
\echo 'Index under test: appointments_doctor_start_at_idx (all statuses)'
\echo '=========================================================================='

\echo ''
\echo '--- (a) without the index ------------------------------------------------'
BEGIN;
DROP INDEX appointments_doctor_start_at_idx;
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) AS total,
       count(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
       COALESCE(
         SUM(EXTRACT(EPOCH FROM (end_at - start_at)) / 60)
           FILTER (WHERE status = 'CONFIRMED'),
         0
       ) AS booked_minutes
FROM appointments
WHERE doctor_id = :'busy_doctor'
  AND start_at >= :'month_start'::timestamptz
  AND start_at <  :'month_end'::timestamptz;
ROLLBACK;

\echo ''
\echo '--- (b) with the index ---------------------------------------------------'
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) AS total,
       count(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
       COALESCE(
         SUM(EXTRACT(EPOCH FROM (end_at - start_at)) / 60)
           FILTER (WHERE status = 'CONFIRMED'),
         0
       ) AS booked_minutes
FROM appointments
WHERE doctor_id = :'busy_doctor'
  AND start_at >= :'month_start'::timestamptz
  AND start_at <  :'month_end'::timestamptz;
