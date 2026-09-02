# Appointments

## Goal

Allow patients to book and cancel appointments safely under concurrent requests.

---

# Booking

A patient provides:

- doctor
- appointment start time
- appointment date

The API determines the corresponding slot end time using the slot duration on the doctor's schedule for that weekday.

---

# Booking Validation

Before booking:

1. Doctor must exist.
2. Requested slot must align with the matching schedule's slot duration.
3. Slot must fall inside doctor's working schedule.
4. Slot must not overlap a blocked period.
5. Slot must not already be booked.
6. Patient must not already hold an overlapping confirmed appointment.
7. Patient must be authorized to book.

Checks 5 and 6 are for error messages only. Both are also enforced by exclusion
constraints, which are what actually hold under concurrency.

---

# Concurrency

The application must NOT rely only on:

```text
SELECT slot
IF slot is free
INSERT appointment
```
This is unsafe because two requests can both observe the slot as available.

The database must enforce the invariant.

Decided approach: a partial GiST **exclusion constraint** preventing overlapping
CONFIRMED appointments for the same doctor. Full reasoning, including why a
partial unique index on `(doctor_id, start_at)` is not sufficient for this
schema, is in `docs/INFRASTRUCTURE/Concurrency.md`.

The application still performs availability checks, for good error messages only.

The database is the final authority.

The insert is attempted and its failure handled. Never
`SELECT`-then-decide-then-`INSERT`, because that gap is the race.

If the constraint rejects the insert (SQLSTATE `23P01`), return HTTP 409 Conflict.

---

# Booking Transaction

Booking is atomic.

```text
BEGIN
  validate schedule, slot-grid alignment, blocks
  INSERT appointment (status CONFIRMED, created_from DIRECT)
  INSERT notifications row (type REMINDER, status PENDING,
                            scheduled_at = start_at - 24h)
  on exclusion_violation -> ROLLBACK, return 409
COMMIT

after commit:
  enqueue delayed reminder job
```

The notification row is written **inside** the transaction; the BullMQ job is
enqueued **after** commit. Reasoning is in
`docs/INFRASTRUCTURE/BackgroundJobs.md` — the row is the source of truth and the
queue is only the trigger, which is what lets the sweeper recover a lost enqueue.

---

# Cancellation

A patient can cancel their own appointment.

Cancellation is forbidden when:

appointment_time - current_time < 2 hours

"Current time" comes from an injected `Clock` provider, never from an inline
`new Date()`. Without that, this rule cannot be unit-tested deterministically —
tests would have to build appointments relative to the real wall clock and would
be brittle. It is a five-line provider that pays for itself immediately.

Example:

Appointment:

15:00

Current time:

12:30

Cancellation allowed.

Current time:

13:30

Cancellation forbidden.

---

# Cancellation Transaction

```text
BEGIN
  verify ownership (patient owns it, or ADMIN)
  verify cancellation window using Clock
  UPDATE appointment SET status = 'CANCELLED', cancelled_at = now()
    WHERE id = $1 AND status = 'CONFIRMED'
  if zero rows affected -> already cancelled, return current state
COMMIT

after commit:
  best-effort: remove the delayed reminder job
  enqueue WAITING_LIST_PROCESS for (doctor_id, start_at)
```

The reminder is stopped by the worker re-checking appointment status at execution
time. Removing the BullMQ job is best-effort only and is never relied upon — see
`docs/INFRASTRUCTURE/BackgroundJobs.md`.

Waiting-list processing must happen asynchronously.

Do not assign the next waiting patient inside the HTTP request.

If the process dies after commit but before the enqueue, the reconciliation
sweeper picks the slot up on its next pass.

---

# Idempotency

Repeated cancellation requests should not produce inconsistent state.

If an appointment is already cancelled, return an appropriate response rather than performing cancellation twice.

--- 

# Important

Do not physically delete appointments when cancelled.

Keep the appointment row with status CANCELLED.

This is required for analytics and auditing.