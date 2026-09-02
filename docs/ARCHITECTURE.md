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

Decided structure:

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
├── notifications/
│   ├── notifications.repository.ts
│   ├── notifications.module.ts
│   └── dto/
│
├── jobs/
│   ├── jobs.module.ts
│   ├── appointment-reminder.processor.ts
│   ├── waiting-list.processor.ts
│   └── reconciliation.processor.ts
│
├── database/
│   ├── migrations/
│   ├── seeds/
│   └── database.module.ts
│
├── common/
│   ├── clock/
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

## Avoiding a circular dependency between appointments and waiting-list

Cancelling an appointment triggers waiting-list processing, and waiting-list
processing creates an appointment. If `AppointmentsModule` and
`WaitingListModule` import each other, `forwardRef` becomes necessary and the
ownership of booking rules gets muddy.

Decided: the **job processor orchestrates**. `waiting-list.processor.ts` reads the
queue through `WaitingListService` and creates the appointment through a narrow
method on `AppointmentsService`. The two feature modules never import each other.

That processor lives in `ProcessorsModule`, which is imported only by the worker
process. `JobsModule` registers the queues and `JobsService` (the producer) and
is imported by both the API and the worker. Putting processors in `JobsModule`
would make every API replica a job runner, so scaling HTTP capacity would
silently double job concurrency — the coupling `docs/DECISIONS.md` #13 exists
to prevent.

```text
JobsModule          (API + worker)   queues, JobsService
ProcessorsModule    (worker only)    reminder, waiting-list, sweeper
   ├── AppointmentsModule
   ├── WaitingListModule
   └── NotificationsModule
```

## Shared infrastructure modules

`common/clock` exports an injectable `Clock` with a single `now()` method. Every
time-dependent business rule — the 2-hour cancellation window, the 24-hour
reminder offset, waiting-list expiry — reads time through it. Tests substitute a
fixed clock. No service calls `new Date()` directly.

`notifications/` owns one table and one repository, consumed by all three job
processors. It centralises the "have we already done this?" check so idempotency
is implemented once rather than per job type.

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