-- Picks the rows every later script measures against, and echoes them, so the
-- captured transcript records exactly which doctor, patient, month and slot
-- produced the numbers. Re-running the seed with the same randomSeed
-- reproduces the same choices.
--
-- Deliberately the busiest doctor, not an average one. docs/TESTING.md: the
-- query plan for the busiest doctor is the one that has to stay fast, and it is
-- the number worth reporting.

\set tz 'Africa/Cairo'

-- JIT compilation adds tens of milliseconds of variance to large sequential
-- scans and none to index lookups, which would flatter the index unfairly.
SET jit = off;

SELECT doctor_id AS busy_doctor
FROM appointments
GROUP BY doctor_id
ORDER BY count(*) DESC
LIMIT 1 \gset

SELECT patient_id AS busy_patient
FROM appointments
GROUP BY patient_id
ORDER BY count(*) DESC
LIMIT 1 \gset

SELECT id AS sample_appointment
FROM appointments
WHERE doctor_id = :'busy_doctor'
ORDER BY start_at DESC
LIMIT 1 \gset

SELECT to_char(date_trunc('month', start_at AT TIME ZONE :'tz'), 'YYYY-MM-DD') AS busy_month
FROM appointments
WHERE doctor_id = :'busy_doctor'
GROUP BY 1
ORDER BY count(*) DESC
LIMIT 1 \gset

SELECT (:'busy_month'::timestamp AT TIME ZONE :'tz')::text AS month_start,
       ((:'busy_month'::timestamp + interval '1 month') AT TIME ZONE :'tz')::text AS month_end
\gset

SELECT now()::text AS win_from,
       (now() + interval '30 days')::text AS win_to
\gset

SELECT doctor_id AS wl_doctor,
       patient_id AS wl_patient,
       slot_start_at::text AS wl_slot
FROM waiting_list
WHERE status = 'WAITING'
ORDER BY created_at
LIMIT 1 \gset

\echo '=========================== measurement context =========================='
\echo 'busy_doctor        =' :'busy_doctor'
\echo 'busy_patient       =' :'busy_patient'
\echo 'sample_appointment =' :'sample_appointment'
\echo 'busy_month         =' :'busy_month'
\echo 'month_start        =' :'month_start'
\echo 'month_end          =' :'month_end'
\echo 'availability from  =' :'win_from'
\echo 'availability to    =' :'win_to'
\echo 'wl_doctor          =' :'wl_doctor'
\echo 'wl_patient         =' :'wl_patient'
\echo 'wl_slot            =' :'wl_slot'

SELECT count(*) AS appointments,
       count(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
       count(DISTINCT doctor_id) AS doctors
FROM appointments;

SELECT count(*) AS appointments_for_busy_doctor
FROM appointments
WHERE doctor_id = :'busy_doctor';
