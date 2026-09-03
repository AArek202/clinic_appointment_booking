-- Scratch dataset for the analytics index measurement, run against the
-- DEVELOPMENT database. Every row it creates is identifiable by the
-- 'perf-...@example.test' email prefix and is removed by
-- scripts/analytics-perf-cleanup.sql.
--
-- Distribution is skewed on purpose (docs/TESTING.md): ten busy doctors and
-- 190 quiet ones, so the plan being measured is the worst case rather than an
-- average one. The full 200-doctor / 2-million-row seed is a separate
-- deliverable; this is sized to run in a couple of minutes on a laptop.

BEGIN;

INSERT INTO users (first_name, last_name, email, password_hash, role)
SELECT 'Perf', 'Doctor ' || i, 'perf-doc-' || i || '@example.test', 'not-a-real-hash', 'DOCTOR'
FROM generate_series(1, 200) AS i;

INSERT INTO users (first_name, last_name, email, password_hash, role)
SELECT 'Perf', 'Patient ' || i, 'perf-pat-' || i || '@example.test', 'not-a-real-hash', 'PATIENT'
FROM generate_series(1, 200) AS i;

INSERT INTO doctors (user_id, specialization)
SELECT id, 'Performance fixture' FROM users WHERE email LIKE 'perf-doc-%';

INSERT INTO patients (user_id)
SELECT id FROM users WHERE email LIKE 'perf-pat-%';

-- One doctor to one patient, so each patient's appointments are exactly one
-- doctor's appointments. Both exclusion constraints are then satisfied simply
-- by giving each doctor a non-overlapping series of start times.
CREATE TEMP TABLE perf_pairs ON COMMIT DROP AS
SELECT d.rn AS k, d.id AS doctor_id, pt.id AS patient_id
FROM (SELECT dd.id, row_number() OVER (ORDER BY u.email) AS rn
      FROM doctors dd JOIN users u ON u.id = dd.user_id
      WHERE u.email LIKE 'perf-doc-%') d
JOIN (SELECT pp.id, row_number() OVER (ORDER BY u.email) AS rn
      FROM patients pp JOIN users u ON u.id = pp.user_id
      WHERE u.email LIKE 'perf-pat-%') pt ON pt.rn = d.rn;

INSERT INTO schedules (doctor_id, day_of_week, start_time, end_time, slot_duration_minutes)
SELECT pr.doctor_id, dow, TIME '09:00:00', TIME '17:00:00', 30
FROM perf_pairs pr
CROSS JOIN generate_series(0, 4) AS dow;

INSERT INTO blocks (doctor_id, start_at, end_at, reason)
SELECT pr.doctor_id,
       TIMESTAMPTZ '2024-03-01 00:00:00+00' + (m * INTERVAL '30 days'),
       TIMESTAMPTZ '2024-03-01 00:00:00+00' + (m * INTERVAL '30 days') + INTERVAL '1 day',
       'perf fixture'
FROM perf_pairs pr
CROSS JOIN generate_series(0, 11) AS m;

-- 31-minute spacing with 30-minute appointments: adjacent rows never overlap,
-- so neither exclusion constraint fires. n % 7 = 0 gives roughly 14% cancelled,
-- matching the distribution described in docs/TESTING.md.
INSERT INTO appointments (doctor_id, patient_id, start_at, end_at, status)
SELECT
  pr.doctor_id,
  pr.patient_id,
  TIMESTAMPTZ '2024-01-01 08:00:00+00' + (n * INTERVAL '31 minutes'),
  TIMESTAMPTZ '2024-01-01 08:00:00+00' + (n * INTERVAL '31 minutes') + INTERVAL '30 minutes',
  CASE WHEN n % 7 = 0 THEN 'CANCELLED' ELSE 'CONFIRMED' END
FROM perf_pairs pr
CROSS JOIN LATERAL generate_series(1, CASE WHEN pr.k <= 10 THEN 8000 ELSE 500 END) AS n;

COMMIT;

ANALYZE appointments;
ANALYZE schedules;
ANALYZE blocks;

SELECT COUNT(*) AS seeded_appointments FROM appointments;
