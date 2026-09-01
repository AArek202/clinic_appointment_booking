# Testing Strategy

Testing focuses on business-critical behavior rather than achieving 100% coverage.

---

# Unit Tests

Test important service behavior.

Examples:

## Booking

- patient can book an available slot
- cannot book an already occupied slot
- cannot book outside doctor's schedule
- cannot book during blocked period
- invalid slot duration is rejected

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
6. Verify all other requests failed with conflict.
7. Verify the database contains exactly one confirmed appointment.

Example expectation:

```text
Successful bookings: 1
Failed bookings: 9
Confirmed appointments in DB: 1
```

The test must use real PostgreSQL rather than an in-memory mock for the concurrency guarantee.
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

---

# Test Philosophy

Do not mock away the behavior being tested.

For example, a concurrency test should not mock PostgreSQL.

The test should prove that the database actually protects the invariant.