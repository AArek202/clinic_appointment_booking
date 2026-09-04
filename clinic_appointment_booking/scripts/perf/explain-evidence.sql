-- Full performance evidence run.
--
--   docker compose exec -T postgres psql -U clinic -d clinic -f /perf/explain-evidence.sql
--
-- Run it twice and keep the second transcript. The first run is measuring how
-- long it takes PostgreSQL to pull pages off disk into shared_buffers, which is
-- a property of the laptop rather than of the index.
--
-- Index names match the live schema (see migrations). Where they differ from
-- the shorthand in docs/DATABASE.md:
--   appointments_patient_start_idx       (not _start_at_idx)
--   blocks_doctor_id_start_at_end_at_idx (not blocks_doctor_time_idx)
--   waiting_list_slot_status_idx         (not waiting_list_doctor_slot_status_idx)

\timing off
\pset pager off

\i /perf/00-context.sql
\i /perf/01-availability.sql
\i /perf/02-patient-appointments.sql
\i /perf/03-analytics-month.sql
\i /perf/04-blocks.sql
\i /perf/05-waiting-list.sql
\i /perf/06-notifications.sql

\echo ''
\echo '=========================== end of evidence =============================='
