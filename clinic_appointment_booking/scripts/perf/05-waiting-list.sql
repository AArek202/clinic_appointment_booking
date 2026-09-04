\echo ''
\echo '=========================================================================='
\echo 'Q5  Assignment job: waiting entries for a freed slot, FIFO'
\echo 'Index under test: waiting_list_slot_status_idx'
\echo '=========================================================================='

\echo ''
\echo '--- (a) without the index ------------------------------------------------'
BEGIN;
DROP INDEX waiting_list_slot_status_idx;
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, patient_id, created_at
FROM waiting_list
WHERE doctor_id = :'wl_doctor'
  AND slot_start_at = :'wl_slot'::timestamptz
  AND status = 'WAITING'
ORDER BY created_at
LIMIT 10;
ROLLBACK;

\echo ''
\echo '--- (b) with the index ---------------------------------------------------'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, patient_id, created_at
FROM waiting_list
WHERE doctor_id = :'wl_doctor'
  AND slot_start_at = :'wl_slot'::timestamptz
  AND status = 'WAITING'
ORDER BY created_at
LIMIT 10;

\echo ''
\echo '=========================================================================='
\echo 'Q6  "Am I already in this queue?"'
\echo 'Index under test: waiting_list_one_active (unique, partial on WAITING)'
\echo '=========================================================================='

\echo ''
\echo '--- (a) without the index ------------------------------------------------'
BEGIN;
DROP INDEX waiting_list_one_active;
DROP INDEX waiting_list_slot_status_idx;
EXPLAIN (ANALYZE, BUFFERS)
SELECT id
FROM waiting_list
WHERE doctor_id = :'wl_doctor'
  AND patient_id = :'wl_patient'
  AND slot_start_at = :'wl_slot'::timestamptz
  AND status = 'WAITING';
ROLLBACK;

\echo ''
\echo '--- (b) with the index ---------------------------------------------------'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id
FROM waiting_list
WHERE doctor_id = :'wl_doctor'
  AND patient_id = :'wl_patient'
  AND slot_start_at = :'wl_slot'::timestamptz
  AND status = 'WAITING';
