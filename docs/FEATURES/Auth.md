# Authentication

## Goal

Provide basic authentication using JWT.

Authentication is intentionally simple because it is not the focus of the task.

---

# Roles

Three roles exist:

ADMIN
PATIENT
DOCTOR

Patients self-register. Doctors do not.

An ADMIN is required to create doctors. Without that role, either anyone could register as a doctor, or doctors would exist only through seeds.

Public registration creates a PATIENT only. The client must not be allowed to choose DOCTOR or ADMIN.

An initial ADMIN can be seeded for local/development use.

---

# Required Behavior

Users should be able to:

- register (patients only)
- login
- receive JWT
- access protected endpoints

JWT should contain enough information to identify:

- user id
- role

---

# Authorization

Use NestJS guards/decorators.

Examples:

Patient-only:

- book appointment
- cancel own appointment
- join waiting list

Doctor-only:

- manage their own schedule (including that schedule's slot duration)
- manage their own blocked periods
- view their analytics

Admin-only:

- create a doctor (user account + doctor profile)

Admin-or-owning-doctor:

- manage a doctor's schedule
- manage a doctor's blocked periods
- view a doctor's analytics

## Ownership check

Decided: schedule and block endpoints are addressed by doctor
(`/doctors/:doctorId/schedules`) and guarded by one reusable rule:

> the caller is ADMIN, or the caller is a DOCTOR whose `doctors.id` equals `:doctorId`.

One check, implemented once, reused by schedules, blocks and analytics. This is
why ADMIN was kept as a third role even though the brief mentions two: an admin
has to create doctors somehow, and once the role exists it costs nothing to let
it manage schedules too.

Patients may read a doctor's availability without any ownership check.

---

# Security

Passwords must never be stored as plain text.

Use a password hashing algorithm such as bcrypt.

JWT secret must come from environment configuration.

---

# Keep It Simple

Do not implement:

- OAuth
- social login
- refresh token rotation
- email verification
- password reset

unless required by the task.

Authentication is supporting functionality, not the focus.