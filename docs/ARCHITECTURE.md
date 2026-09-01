# Architecture

## Goal

Use a simple feature-based layered architecture.

The default request flow is:

Controller
    ↓
Service
    ↓
Repository
    ↓
PostgreSQL

Infrastructure such as authentication and background jobs sits beside the feature modules.

The project should remain easy for a junior developer to understand and explain during the technical interview.

---

# Project Structure

Recommended structure:

src/
├── app.module.ts
│
├── auth/
│   ├── auth.controller.ts
│   ├── auth.service.ts
│   ├── auth.module.ts
│   ├── guards/
│   ├── decorators/
│   └── dto/
│
├── doctors/
│   ├── doctors.controller.ts
│   ├── doctors.service.ts
│   ├── doctors.repository.ts
│   ├── doctors.module.ts
│   └── dto/
│
├── schedules/
│   ├── schedules.controller.ts
│   ├── schedules.service.ts
│   ├── schedules.repository.ts
│   ├── schedules.module.ts
│   └── dto/
│
├── appointments/
│   ├── appointments.controller.ts
│   ├── appointments.service.ts
│   ├── appointments.repository.ts
│   ├── appointments.module.ts
│   └── dto/
│
├── availability/
│   ├── availability.controller.ts
│   ├── availability.service.ts
│   ├── availability.repository.ts
│   ├── availability.module.ts
│   └── dto/
│
├── waiting-list/
│   ├── waiting-list.controller.ts
│   ├── waiting-list.service.ts
│   ├── waiting-list.repository.ts
│   ├── waiting-list.module.ts
│   └── dto/
│
├── analytics/
│   ├── analytics.controller.ts
│   ├── analytics.service.ts
│   ├── analytics.repository.ts
│   ├── analytics.module.ts
│   └── dto/
│
├── jobs/
│   ├── jobs.module.ts
│   ├── appointment-reminder.processor.ts
│   └── waiting-list.processor.ts
│
├── database/
│   ├── migrations/
│   └── database.module.ts
│
├── common/
│   ├── enums/
│   ├── decorators/
│   ├── filters/
│   └── types/
│
└── main.ts

---

# Layer Responsibilities

## Controller

Responsible for:

- HTTP endpoints
- Parsing request parameters
- Calling services
- Returning responses
- HTTP status codes

Controllers must NOT:

- Query PostgreSQL directly
- Contain booking business rules
- Perform complex calculations
- Manage transactions directly unless there is a strong reason

---

## Service

Responsible for:

- Business rules
- Validation that depends on business logic
- Coordinating repositories
- Transactions
- Calling background job queues

Examples:

- Check whether cancellation is allowed.
- Check whether a slot can be booked.
- Create an appointment.
- Cancel an appointment.
- Add a patient to a waiting list.
- Enqueue a waiting-list processing job.

---

## Repository

Responsible for:

- Database queries
- Query builders
- Raw SQL
- Persistence operations

Repositories should not contain HTTP logic.

Repositories should not decide business policy.

---

## DTOs

DTOs are responsible for validating API input.

Use:

- class-validator
- class-transformer

Do not duplicate DTO validation unnecessarily inside controllers.

---

# Feature Ownership

Each feature should own its:

- controller
- service
- repository
- DTOs
- module

Avoid creating large global files such as:

- giant appointment.service.ts containing unrelated functionality
- giant utils.ts
- giant database.service.ts containing every query

---

# Dependencies

Preferred dependency direction:

Controller → Service → Repository

Do not reverse this dependency.

For example:

Repository must not import Controller.

Service must not depend on HTTP request/response objects.

---

# Transactions

Transactions belong in the service/application layer when an operation spans multiple database changes.

Booking and cancellation are transactional operations.

The transaction must protect the business invariant that:

> A doctor cannot have two confirmed appointments occupying the same slot.

---

# Simplicity Rule

Before introducing a new abstraction ask:

1. Is it required by the task?
2. Does it make the code easier to understand?
3. Can the requirement be solved with the existing architecture?

If the answer is no, do not introduce the abstraction.

Do not introduce patterns just for demonstration purposes.