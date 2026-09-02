# Stack

## Backend

- NestJS
- TypeScript
- Node.js

## Database

- PostgreSQL
- TypeORM
- `btree_gist` extension, required by the appointment overlap exclusion constraint

## Date & Time

- `CLINIC_TZ` environment variable defines the single clinic timezone
- Luxon for timezone-aware schedule expansion in application code
- PostgreSQL `AT TIME ZONE` for month bucketing inside the analytics query

JavaScript's built-in `Date` cannot convert between a named IANA timezone and UTC
without help, which is exactly what schedule expansion needs. Luxon is used only
at that boundary, not spread through the codebase.

## Authentication

- JWT
- NestJS Guards
- Role-based authorization

## Background Jobs

- BullMQ
- Redis

## Validation

- class-validator
- class-transformer

## Testing

- Jest
- Supertest

## Infrastructure

- Docker
- Docker Compose
- nginx as a load balancer in front of two or more app replicas, so the
  concurrency proof runs against the distributed setup the task describes

## API

REST API using JSON request/response bodies.

---

# Database Rules

- PostgreSQL is the source of truth.
- Do not use `synchronize: true`.
- Database changes must be implemented through migrations.
- Foreign keys should be used where appropriate.
- Constraints should be used to protect business invariants at the database level.
- Important queries must have appropriate indexes.

---

# General Rules

1. Use TypeScript.
2. Prefer simple solutions over abstractions.
3. Do not introduce unnecessary design patterns.
4. Do not introduce microservices.
5. Do not introduce CQRS.
6. Do not introduce event sourcing.
7. Do not introduce a message broker other than Redis/BullMQ.
8. Keep business logic inside services.
9. Keep database access inside repositories.
10. Controllers should remain thin.