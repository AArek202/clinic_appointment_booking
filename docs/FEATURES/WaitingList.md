# Waiting List

## Goal

If a requested slot is already booked, a patient can join a waiting list.

When the appointment is cancelled, a background job processes the queue.

---

# Assumptions

The implementation should document these assumptions in README.

Recommended assumptions:

1. Waiting-list entries are FIFO.
2. Earlier entries have higher priority.
3. A patient cannot join the same slot twice.
4. Only one active waiting-list entry per patient/slot is allowed.
5. When a slot becomes available, the first eligible waiting patient receives it.
6. Assignment happens through BullMQ.
7. Assignment is transactional.
8. If a waiting patient is no longer eligible, skip them.
9. A successful assignment removes/marks the waiting-list entry as ASSIGNED.
10. The job is safe to retry.

---

# Queue Processing

Cancellation should enqueue:

WAITING_LIST_PROCESS

The HTTP request must not synchronously assign the next patient.

---

# Assignment

The worker should:

1. Find the earliest eligible waiting patient.
2. Attempt to create the appointment.
3. Use the same database concurrency protection as normal booking.
4. Mark the waiting-list entry as assigned.
5. Commit atomically.

If another request has already filled the slot, the job must not overwrite it.

---

# Retry Safety

Jobs can execute more than once.

Therefore:

Do not assume:

```text
job runs once
```

Instead design for:

```text
job may run multiple times
```
Repeated execution must not create multiple appointments for the same slot.

---

# Expiry

Waiting-list entries may have an expiry timestamp.

Expired entries are skipped.

The exact expiry policy should be documented in README.

---

# Notification

No real email/SMS is required.

Logging or a notifications table is sufficient.