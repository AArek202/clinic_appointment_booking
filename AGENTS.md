# AI Coding Agent Instructions

You are implementing a Backend Developer technical task.

Project documentation lives under `docs/`. Read these files before writing code:

1. docs/DECISIONS.md
2. docs/STACK.md
3. docs/ARCHITECTURE.md
4. docs/DEVELOPMENT.md
5. docs/DATABASE.md
6. docs/API.md
7. Relevant files under docs/FEATURES/
8. Relevant files under docs/INFRASTRUCTURE/

---

# Requirement Priority

When requirements conflict, use this priority:

1. Explicit task requirements
2. docs/DECISIONS.md
3. Database correctness and concurrency guarantees
4. Security and authorization
5. Business rules documented in docs/FEATURES/
6. docs/ARCHITECTURE.md
7. docs/DEVELOPMENT.md
8. Agent implementation preferences

Never sacrifice correctness to preserve an architectural preference.

docs/DECISIONS.md records settled decisions together with the alternatives that were
rejected and why. Do not silently re-open a settled decision. If implementation
reveals that a decision is wrong, say so explicitly and update docs/DECISIONS.md
along with the affected docs.

---

# Primary Goal

Build a Clinic Appointment Booking REST API using:

NestJS
PostgreSQL
TypeORM
JWT
BullMQ
Redis
Docker

Follow the project requirements provided by the user.

---

# Architecture

Use:

Controller
↓
Service
↓
Repository
↓
Database

Do not introduce unnecessary architectural patterns.

---

# Important Requirements

The implementation MUST include:

- doctor weekly schedules
- configurable slot duration on schedules
- blocked dates/times
- availability endpoint
- appointment booking
- appointment cancellation
- 2-hour cancellation restriction
- JWT authentication
- patient/doctor/admin roles
- monthly doctor analytics
- SQL-based analytics
- database-level booking concurrency protection
- concurrency proof test against multiple app replicas behind nginx
- indexes for scale, justified with EXPLAIN ANALYZE against seeded data
- seed script (~200 doctors, ~2M appointments)
- waiting list
- BullMQ/Redis
- appointment reminders
- cancellation-safe reminders
- background waiting-list processing
- reconciliation sweeper job
- retry-safe jobs
- injectable Clock for all time-dependent rules
- single clinic timezone via CLINIC_TZ
- database migrations
- Docker Compose
- tests
- README

---

# Implementation Rules

## 1. Inspect Before Modifying

Before changing existing code:

- inspect the relevant files
- understand existing conventions
- reuse existing utilities when appropriate

Do not overwrite working code unnecessarily.

---

## 2. Database First

When introducing persistent functionality:

1. Define/update entity.
2. Create migration.
3. Add indexes/constraints.
4. Implement repository.
5. Implement service.
6. Implement controller.
7. Add tests.

---

## 3. Business Logic

Business rules belong in services.

Examples:

- cancellation window
- slot validation
- waiting-list eligibility
- booking rules

---

## 4. Database Rules

PostgreSQL must protect critical invariants.

Especially:

> No two confirmed appointments may overlap for the same doctor.

Enforced by a partial GiST exclusion constraint. Never rely solely on a prior
SELECT to determine whether a slot can be booked.

---

## 5. Background Jobs

Never assume a job executes exactly once.

Every worker must be safe to retry.

Enqueue only after the transaction commits. Job payloads carry identifiers, not
state — workers re-derive every decision from the database.

Idempotency is a unique constraint plus a conditional status update acted on by
affected row count. Reading "already done?" and then writing "done" is a race.

---

## 6. Tests

Prioritize tests for:

- booking
- cancellation
- concurrency
- waiting list
- reminder idempotency

The concurrency test must use a real PostgreSQL database.

---

## 7. Documentation

When making an important design decision:

- document the decision in the appropriate file under docs/
- update README if it affects the requested deliverables

---

# Avoid

Do NOT introduce:

- microservices
- CQRS
- event sourcing
- unnecessary repository abstractions
- unnecessary factories
- unnecessary strategies
- unnecessary interfaces
- GraphQL
- Kafka
- Kubernetes
- external notification providers

unless explicitly required.

---

# Code Quality

Prefer:

- simple
- explicit
- readable
- testable
- maintainable

over:

- clever
- highly abstract
- excessively generic

The developer must be able to explain the implementation during a 45-minute technical discussion.

---

# Before Declaring Complete

Verify:

[ ] Application starts

[ ] PostgreSQL starts

[ ] Redis starts

[ ] Migrations run

[ ] Authentication works

[ ] Patient role works

[ ] Doctor role works

[ ] Admin can create doctors

[ ] Doctor schedule works

[ ] Slot duration works

[ ] Blocked periods work

[ ] Availability works

[ ] Booking works

[ ] Duplicate booking fails

[ ] Cancellation works

[ ] <2-hour cancellation is rejected

[ ] Analytics use SQL

[ ] Waiting list works

[ ] Reminder job works

[ ] Cancelled appointment does not trigger reminder

[ ] Jobs are retry-safe

[ ] Concurrency test proves exactly one booking

[ ] Concurrency test runs against multiple replicas behind nginx

[ ] Losing bookings return 409, not 500

[ ] Reconciliation sweeper recovers a lost job

[ ] Indexes exist, with EXPLAIN ANALYZE evidence against seeded data

[ ] README documents decisions

[ ] AI usage section exists

[ ] Docker Compose starts the system

[ ] Tests pass
