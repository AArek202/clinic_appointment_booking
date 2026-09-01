# Concurrency Strategy

## Problem

Multiple API instances may receive booking requests for the same slot simultaneously.

Example:

Patient A → API instance 1 → PostgreSQL
Patient B → API instance 2 → PostgreSQL

Both requests may see:

"slot is available"

If the application only checks availability before inserting, both may succeed.

---

# Required Invariant

For a given doctor and slot:

At most one CONFIRMED appointment may exist.

---

# Preferred Solution

Enforce the invariant in PostgreSQL.

Use a unique index/constraint based on the doctor's identity and appointment slot.

If cancelled appointments remain in the table, a partial unique index can restrict uniqueness to:

status = CONFIRMED

Conceptually:

UNIQUE(doctor_id, start_datetime)
WHERE status = CONFIRMED

The exact PostgreSQL implementation should be chosen based on the final schema.

---

# Why Database-Level Protection?

Application-level checks are vulnerable to race conditions.

Database constraints operate correctly even when:

- multiple NestJS instances exist
- multiple requests arrive simultaneously
- requests run on different processes
- requests run on different machines

---

# Application Behavior

Normal booking:

1. Validate request.
2. Validate schedule.
3. Validate blocked periods.
4. Attempt INSERT.
5. PostgreSQL enforces uniqueness.
6. If uniqueness violation occurs:
   return 409 Conflict.

---

# Alternatives Considered

## Application-level check

Rejected as the only protection.

Reason:

Race condition between SELECT and INSERT.

---

## Pessimistic locking

Possible, but requires choosing and consistently locking the correct rows.

There may not be an appointment row to lock when the slot is empty.

Therefore it is more complicated for this use case.

---

## Redis distributed lock

Not preferred as the primary source of truth.

Redis can coordinate application instances, but PostgreSQL already owns appointment consistency.

A distributed lock also introduces another failure mode.

---

# Conclusion

PostgreSQL should enforce the booking invariant.

The application can perform normal availability checks, but the database is the final authority.

---

# Proof

The repository must contain a concurrency test that sends multiple simultaneous booking requests for the same slot.

Expected:

Exactly one successful booking.

All competing requests must fail safely.

Database must contain exactly one confirmed appointment.