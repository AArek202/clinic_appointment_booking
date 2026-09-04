-- Removes everything scripts/analytics-perf-seed.sql created, in foreign-key
-- order. Matching on the email prefix means real development data is untouched.

DELETE FROM appointments a
USING doctors d, users u
WHERE a.doctor_id = d.id AND d.user_id = u.id AND u.email LIKE 'perf-%@example.test';

DELETE FROM blocks b
USING doctors d, users u
WHERE b.doctor_id = d.id AND d.user_id = u.id AND u.email LIKE 'perf-%@example.test';

DELETE FROM schedules s
USING doctors d, users u
WHERE s.doctor_id = d.id AND d.user_id = u.id AND u.email LIKE 'perf-%@example.test';

DELETE FROM doctors d
USING users u
WHERE d.user_id = u.id AND u.email LIKE 'perf-%@example.test';

DELETE FROM patients p
USING users u
WHERE p.user_id = u.id AND u.email LIKE 'perf-%@example.test';

DELETE FROM users WHERE email LIKE 'perf-%@example.test';

ANALYZE appointments;
