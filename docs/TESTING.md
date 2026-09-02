# Testing Strategy

Testing focuses on business-critical behavior rather than achieving 100% coverage.

---

# Deterministic Time

All time-dependent rules are tested through the injected `Clock` (see
`docs/ARCHITECTURE.md`). Tests substitute a fixed clock rather than constructing
fixtures relative to the real wall clock.

This applies to the 2-hour cancellation window, the 24-hour reminder offset and
waiting-list expiry. Any test that would be flaky at 23:59 is written wrong.

---

# Unit Tests

Test important service behavior.

The slot generator is a pure function and gets the densest unit coverage:
schedule expansion, slot-grid alignment, block subtraction, half-open interval
boundaries, and DST transition dates.

Examples:

## Booking

- patient can book an available slot
- cannot book an already occupied slot
- cannot book outside doctor's schedule
- cannot book during blocked period
- invalid slot duration is rejected
- cannot book a slot overlapping one the patient already holds with another doctor
- a slot not aligned to the doctor's grid is rejected
- `endAt` supplied by the client is ignored, never trusted

## Cancellation

- patient can cancel their appointment
- patient cannot cancel another patient's appointment
- cancellation less than 2 hours before appointment is rejected
- cancellation at least 2 hours before appointment succeeds

## Waiting List

- patient can join occupied slot
- duplicate waiting-list entry is rejected
- cancelled appointment triggers waiting-list job
- waiting patient can receive the slot

---

# Integration Tests

Use PostgreSQL where database behavior matters.

Important database tests include:

- appointment uniqueness
- transaction behavior
- waiting-list assignment
- migrations

---

# Concurrency Test

A dedicated test/script must:

1. Create one available slot.
2. Create multiple patients.
3. Send concurrent booking requests for the same slot.
4. Wait for all requests.
5. Verify exactly one request succeeded.
6. Verify all other requests failed with 409 specifically.
7. Verify no request failed with 5xx.
8. Verify the database contains exactly one confirmed appointment.

Example expectation:

```text
Successful bookings: 1
Conflicted bookings (409): 9
Unexpected errors (5xx): 0
Confirmed appointments in DB: 1
```

Decided: the script fires at **nginx in front of two or more app replicas**, not
at a single process. The task's stated threat model is several instances behind a
load balancer, so the proof should match it. A single-process `Promise.all` would
still exercise the database constraint correctly, but it would not demonstrate
the claim that was actually made.

Asserting 409 rather than "not 201" matters. A 500 would also be a failed
booking, but it would mean the constraint fired while the error mapping did not —
a real bug that a looser assertion hides.

The test must use real PostgreSQL rather than an in-memory mock. Mocking the
database here would mean mocking away the entire thing being proven.

---

# Performance Evidence

A seed script generates roughly 200 doctors and 2 million appointments.

## Seed distribution

Decided: **skewed, not uniform.**

- A small number of popular doctors hold a disproportionate share of
  appointments; the rest hold far fewer.
- Appointments spread across roughly 24 months, so month-bounded analytics
  queries have to actually discriminate on the range.
- About 15% cancelled, so the cancellation-rate metric and the partial indexes
  both have realistic data to work against.

A uniform 10,000 rows per doctor would be simpler to generate, but it would also
be the easiest possible case for every index — each doctor's rows would be a
small, evenly sized slice. The skew is what produces a worst case: the query plan
for the busiest doctor is the one that has to stay fast, and that is the number
worth reporting.

## What to capture

For each index in `docs/DATABASE.md`, capture `EXPLAIN ANALYZE` for its named
query, before and after the index exists, and put the output in the README.
Measure against one of the *busiest* doctors, not an average one.

This turns "I added indexes" into a measurement. The availability query over a
date range and the monthly analytics query are the two that matter.

---

# Test Database

Integration tests need a real PostgreSQL and Redis. Both are provided by
`docker-compose`, with a separate test database.

Migrations run before the integration suite; they are never replaced by
`synchronize: true`, not even in tests, because migration correctness is itself
part of what is being verified.

Get one integration test green early. The harness is more work than it looks,
especially on Windows with TypeORM migrations under `ts-node`, and it is worth
having in place before time pressure arrives.

---

# Background Job Tests

Reminder jobs:

- successful reminder creates/sends exactly one notification
- retry does not create duplicate notifications
- cancelled appointment does not send reminder

Waiting-list jobs:

- retry does not assign the slot twice
- only one waiting-list patient receives the slot
- already assigned/cancelled jobs are safely ignored
- a direct booking winning the race leaves the job a successful no-op
- the assigned appointment gets its own reminder notification
- expired entries are skipped in favour of the next eligible patient
- a candidate who is busy elsewhere at that time is skipped, and the next
  eligible patient gets the slot
- the candidate loop survives a rejected insert without aborting the whole
  transaction (savepoint behaviour)

Reconciliation sweeper:

- a cancelled slot with waiting entries but no enqueued job is picked up
- a due PENDING notification whose job was lost is sent
- running the sweeper twice produces no duplicate side effects

---

# Test Philosophy

Do not mock away the behavior being tested.

For example, a concurrency test should not mock PostgreSQL.

The test should prove that the database actually protects the invariant.