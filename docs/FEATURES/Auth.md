# Authentication

## Goal

Provide basic authentication using JWT.

Authentication is intentionally simple because it is not the focus of the task.

---

# Roles

Two roles exist:

PATIENT
DOCTOR

---

# Required Behavior

Users should be able to:

- register
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

- manage doctor schedule
- manage blocked periods
- view their analytics

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