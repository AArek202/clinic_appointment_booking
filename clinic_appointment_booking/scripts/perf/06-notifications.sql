\echo ''
\echo '=========================================================================='
\echo 'Q7  Job idempotency: have we already handled this appointment?'
\echo 'Index under test: notifications_unique_per_type'
\echo '=========================================================================='

\echo ''
\echo '--- (a) without the index ------------------------------------------------'
BEGIN;
ALTER TABLE notifications DROP CONSTRAINT notifications_unique_per_type;
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, sent_at
FROM notifications
WHERE appointment_id = :'sample_appointment'
  AND type = 'REMINDER';
ROLLBACK;

\echo ''
\echo '--- (b) with the index ---------------------------------------------------'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, sent_at
FROM notifications
WHERE appointment_id = :'sample_appointment'
  AND type = 'REMINDER';

\echo ''
\echo '=========================================================================='
\echo 'Q8  Reconciliation sweeper: due but unsent notifications'
\echo 'Index under test: notifications_pending_due_idx (partial on PENDING)'
\echo '=========================================================================='

SELECT status, count(*) FROM notifications GROUP BY status ORDER BY 2 DESC;

\echo ''
\echo '--- (a) without the index ------------------------------------------------'
BEGIN;
DROP INDEX notifications_pending_due_idx;
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, appointment_id, scheduled_at
FROM notifications
WHERE status = 'PENDING'
  AND scheduled_at <= now()
ORDER BY scheduled_at
LIMIT 100;
ROLLBACK;

\echo ''
\echo '--- (b) with the index ---------------------------------------------------'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, appointment_id, scheduled_at
FROM notifications
WHERE status = 'PENDING'
  AND scheduled_at <= now()
ORDER BY scheduled_at
LIMIT 100;
