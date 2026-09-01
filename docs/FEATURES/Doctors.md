# Doctors

## Goal

Represent doctors as clinic staff who have a profile and own weekly schedules.

Doctors are created by an ADMIN. They do not self-register.

Slot duration is not a doctor-level setting. It belongs on each schedule. See `docs/FEATURES/Schedules.md`.

---

# Doctor Profile

A doctor is linked to a user account (`user_id` unique).

Profile fields should include:

- specialization
- achievements

---

# Requirements

Admin can:

- create a doctor (user account with role DOCTOR + doctor profile)

A doctor should be able to:

- view their own profile

Doctors must not modify another doctor's profile.

---

# Slot Duration

Do not store slot duration on the doctor.

Each weekly schedule row has its own `slot_duration_minutes`. Availability and booking use that schedule's duration.
