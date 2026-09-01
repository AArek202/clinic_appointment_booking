# Background Jobs

Use BullMQ with Redis.

Two required job types:

1. Appointment reminder
2. Waiting-list processing

---

# Appointment Reminder

When an appointment is confirmed:

enqueue a reminder job scheduled for:

appointment time - 24 hours

The job should "send" a reminder by:

- logging it
- or inserting a notification record

No real email/SMS is required.

---

# Cancellation

If an appointment is cancelled, its reminder must not fire.

Do not rely only on removing the BullMQ job.

The reminder worker must also verify appointment state before sending.

Therefore:

job starts
↓
load appointment
↓
if appointment is CANCELLED
    stop
↓
if reminder already sent
    stop
↓
send/write notification
↓
mark reminder as sent

---

# Idempotency

Jobs can run multiple times.

Every job must be safe to retry.

For reminders, use a unique notification identity such as:

appointment_id + notification_type

The database should prevent duplicate reminder records.

---

# Waiting List

When an appointment is cancelled:

enqueue:

WAITING_LIST_PROCESS

The worker attempts to assign the slot.

The worker must use the same database-level protection as normal booking.

---

# Retry

BullMQ should be configured with retries/backoff appropriate for the task.

A failed job should not cause:

- duplicate reminders
- duplicate appointments
- duplicate waiting-list assignments

---

# Worker Failure

Assume:

- Redis temporarily unavailable
- worker crashes
- process restarts
- job executes more than once

The implementation must remain safe under these conditions.

---

# Important Principle

Queue delivery is not assumed to be exactly-once.

Design consumers to be idempotent.