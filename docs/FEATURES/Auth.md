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
- manage blocked periods
- view their analytics

Admin-only:

- create a doctor (user account + doctor profile)

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