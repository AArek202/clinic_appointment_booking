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
6. Patient must be authorized to book.

---

# Concurrency

The application must NOT rely only on:

```text
SELECT slot
IF slot is free
INSERT appointment
```
This is unsafe because two requests can both observe the slot as available.

The database must enforce the uniqueness invariant.

Preferred approach:

Use a PostgreSQL unique constraint/index representing:

doctor + slot start + active booking

If PostgreSQL partial unique indexes are used, only CONFIRMED appointments should participate.

The application should still perform availability checks for good error messages.

The database is the final authority.

If the database rejects a conflicting insert:

return HTTP 409 Conflict.

---

# Booking Transaction

Booking should be atomic.

Conceptually:

BEGIN

validate relevant data
attempt to create appointment

if database uniqueness violation:
rollback
return conflict

COMMIT

The exact implementation may use TypeORM transaction APIs.

---

# Cancellation

A patient can cancel their own appointment.

Cancellation is forbidden when:

appointment_time - current_time < 2 hours

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

Cancellation should:

1. verify ownership
2. verify cancellation window
3. mark appointment CANCELLED
4. prevent reminder from firing
5. enqueue WAITING_LIST_PROCESS

Waiting-list processing must happen asynchronously.

Do not assign the next waiting patient inside the HTTP request.

---

# Idempotency

Repeated cancellation requests should not produce inconsistent state.

If an appointment is already cancelled, return an appropriate response rather than performing cancellation twice.

--- 

# Important

Do not physically delete appointments when cancelled.

Keep the appointment row with status CANCELLED.

This is required for analytics and auditing.