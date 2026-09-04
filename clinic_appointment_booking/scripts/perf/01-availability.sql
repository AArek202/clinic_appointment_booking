\echo ''
\echo '=========================================================================='
\echo 'Q1  Availability: confirmed appointments for one doctor over 30 days'
\echo 'Index under test: appointments_no_overlap (GiST, partial on CONFIRMED)'
\echo '=========================================================================='

\echo ''
\echo '--- (a) no appointments index at all -------------------------------------'
BEGIN;
ALTER TABLE appointments DROP CONSTRAINT appointments_no_overlap;
DROP INDEX appointments_doctor_start_at_idx;
EXPLAIN (ANALYZE, BUFFERS)
SELECT start_at, end_at
FROM appointments
WHERE doctor_id = :'busy_doctor'
  AND status = 'CONFIRMED'
  AND tstzrange(start_at, end_at, '[)')
      && tstzrange(:'win_from'::timestamptz, :'win_to'::timestamptz, '[)')
ORDER BY start_at;
ROLLBACK;

\echo ''
\echo '--- (b) GiST gone, btree (doctor_id, start_at) still present -------------'
BEGIN;
ALTER TABLE appointments DROP CONSTRAINT appointments_no_overlap;
EXPLAIN (ANALYZE, BUFFERS)
SELECT start_at, end_at
FROM appointments
WHERE doctor_id = :'busy_doctor'
  AND status = 'CONFIRMED'
  AND tstzrange(start_at, end_at, '[)')
      && tstzrange(:'win_from'::timestamptz, :'win_to'::timestamptz, '[)')
ORDER BY start_at;
ROLLBACK;

\echo ''
\echo '--- (c) with the GiST index ----------------------------------------------'
EXPLAIN (ANALYZE, BUFFERS)
SELECT start_at, end_at
FROM appointments
WHERE doctor_id = :'busy_doctor'
  AND status = 'CONFIRMED'
  AND tstzrange(start_at, end_at, '[)')
      && tstzrange(:'win_from'::timestamptz, :'win_to'::timestamptz, '[)')
ORDER BY start_at;
