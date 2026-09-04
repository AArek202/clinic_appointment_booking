\echo ''
\echo '=========================================================================='
\echo 'Q4  Blocked periods overlapping an availability window'
\echo 'Index under test: blocks_doctor_id_start_at_end_at_idx'
\echo 'NOTE: blocks is a small table. A sequential scan winning here is the'
\echo '      planner being correct, not the index being wrong. Record what'
\echo '      actually happens.'
\echo 'NOTE: blocks_no_overlap leaves a GiST index on (doctor_id, tstzrange).'
\echo '      The (a) block drops only the btree, so (a) may still show an index'
\echo '      scan on the constraint index for the doctor_id equality. That is'
\echo '      a real result, not a broken measurement.'
\echo '=========================================================================='

SELECT count(*) AS total_blocks, pg_size_pretty(pg_total_relation_size('blocks')) AS size
FROM blocks;

\echo ''
\echo '--- (a) without the index ------------------------------------------------'
BEGIN;
DROP INDEX blocks_doctor_id_start_at_end_at_idx;
EXPLAIN (ANALYZE, BUFFERS)
SELECT start_at, end_at, reason
FROM blocks
WHERE doctor_id = :'busy_doctor'
  AND start_at < :'win_to'::timestamptz
  AND end_at   > :'win_from'::timestamptz;
ROLLBACK;

\echo ''
\echo '--- (b) with the index ---------------------------------------------------'
EXPLAIN (ANALYZE, BUFFERS)
SELECT start_at, end_at, reason
FROM blocks
WHERE doctor_id = :'busy_doctor'
  AND start_at < :'win_to'::timestamptz
  AND end_at   > :'win_from'::timestamptz;
