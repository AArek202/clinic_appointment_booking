\echo ''
\echo '=========================================================================='
\echo 'Q2  "List my appointments" and the cancel ownership check'
\echo 'Index under test: appointments_patient_start_idx'
\echo '=========================================================================='

\echo ''
\echo '--- (a) no patient index at all ------------------------------------------'
BEGIN;
DROP INDEX appointments_patient_start_idx;
ALTER TABLE appointments DROP CONSTRAINT appointments_patient_no_overlap;
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, doctor_id, start_at, end_at, status
FROM appointments
WHERE patient_id = :'busy_patient'
ORDER BY start_at DESC
LIMIT 50;
ROLLBACK;

\echo ''
\echo '--- (b) btree gone, only the patient GiST constraint index remains -------'
BEGIN;
DROP INDEX appointments_patient_start_idx;
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, doctor_id, start_at, end_at, status
FROM appointments
WHERE patient_id = :'busy_patient'
ORDER BY start_at DESC
LIMIT 50;
ROLLBACK;

\echo ''
\echo '--- (c) with the btree index ---------------------------------------------'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, doctor_id, start_at, end_at, status
FROM appointments
WHERE patient_id = :'busy_patient'
ORDER BY start_at DESC
LIMIT 50;
