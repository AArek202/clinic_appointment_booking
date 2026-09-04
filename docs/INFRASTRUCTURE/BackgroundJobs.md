# Background Jobs

Use BullMQ with Redis.

Three job types:

1. Appointment reminder
2. Waiting-list processing
3. Reconciliation sweeper (repeatable)

---

# Transaction Boundary: PostgreSQL and Redis Cannot Commit Together

This is the central design problem for jobs, so the rule is stated before the
jobs themselves.

A database transaction and a Redis enqueue are two separate systems. There is no
shared transaction. Only two orderings exist, and both can fail:

Enqueue **inside** the transaction: the worker can pick the job up and start
running before the transaction commits — or after it rolls back. It then reads an
appointment that is not cancelled yet, correctly decides to do nothing, and the
slot is never reassigned.

Enqueue **after** the transaction commits: if the process dies in the gap, the
job is simply lost. The cancellation succeeded and the waiting list never advances.

## Decided approach

1. **Enqueue only after commit.** Never inside the transaction.
2. **Jobs re-derive their decision from the database.** The job payload carries
   identifiers only, never state such as "this appointment is cancelled". Anything
   the worker acts on is re-read inside the worker.
3. **A repeatable sweeper closes the crash window.** It catches work that was
   committed but never enqueued.

This accepts a bounded delay (until the next sweep) in exchange for three small,
individually explainable moving parts.

## Alternative considered: transactional outbox

Job intents would be written to an `outbox` table inside the same transaction,
and a poller would drain that table into BullMQ. Strictly stronger — no job can
ever be lost, because the intent and the state change commit atomically.

Rejected as disproportionate here: it means building, testing and explaining a
second queueing mechanism on top of the one the task asks for, to remove a
failure window that the sweeper already covers. Recorded in the README as the
alternative considered.

---

# Reconciliation Sweeper

A BullMQ repeatable job running **every minute** that re-derives pending work
from the database.

One minute means recovery from a lost job is bounded by roughly a minute, which
is well inside anything a patient would notice, and the queries are indexed
lookups over small result sets — negligible load at this scale. It is also short
enough to demonstrate live in the screen recording without waiting around.

Each pass handles:

1. CANCELLED appointments whose slot still has `WAITING` waiting-list entries
   -> enqueue waiting-list processing for that slot.
2. `notifications` rows with `status = 'PENDING'` and `scheduled_at <= now()`
   whose appointment is still CONFIRMED -> send them.
3. `waiting_list` rows past their `expires_at`, or whose slot time has passed
   -> mark EXPIRED.

The sweeper is the recovery story for more than the commit gap. Delayed BullMQ
jobs live only in Redis, and Redis runs without persistence by decision
(`docs/DECISIONS.md` #14), so restarting it drops the delayed set. Because
`notifications` rows are written to PostgreSQL when the appointment is confirmed,
nothing is lost: a reminder that was already due goes out on the next sweep, and
one still in the future is sent when its `scheduled_at` arrives. Redis is treated
as a scheduler, not as a store of record.

Every sweeper action is idempotent, so running it concurrently on multiple app
instances is safe.

---

# Appointment Reminder

When an appointment is confirmed, inside the booking transaction, insert a
`notifications` row with:

- type REMINDER
- status PENDING
- scheduled_at = appointment start_at - 24 hours

After the transaction commits, enqueue a delayed BullMQ job for `scheduled_at`.

The row is the source of truth; the queue is only the trigger. That is what makes
the sweeper able to recover lost jobs.

The job "sends" the reminder by logging it and marking the row SENT. No real
email/SMS is required.

## Reminders scheduled in the past

If an appointment is booked less than 24 hours before it starts, `scheduled_at`
is already in the past.

Decided: the notification row is still created, and the job is enqueued with no
delay so the reminder fires immediately. The alternative — skipping the reminder
entirely — is also defensible, but firing immediately means every confirmed
appointment has exactly one reminder record, which keeps the invariant simple to
state and to test.

---

# Cancellation

If an appointment is cancelled, its reminder must not fire.

Do not rely on removing the BullMQ job. Job removal can fail, the worker may
already be executing, and Redis may have been restarted. Removal is best-effort
only; the database check is the actual guarantee.

The reminder worker verifies appointment state at execution time:

```text
job starts
↓
load appointment by id
↓
appointment missing or status != CONFIRMED
    -> exit successfully, send nothing
↓
conditional UPDATE notifications ... WHERE status = 'PENDING'
↓
zero rows affected
    -> another worker already sent it, exit successfully
↓
log the reminder
```

This is the same principle as the booking concurrency decision: the database is
the authority, and the queue is only a trigger.

---

# Idempotency

Jobs can run multiple times.

Every job must be safe to retry.

Identity is `UNIQUE (appointment_id, type)` on `notifications`, so a duplicate
record cannot exist even if two workers process the same job simultaneously.

But a unique constraint alone is not enough. Reading "is it already sent?" and
then writing "sent" is itself a race between two workers. The transition must be
a single conditional update, and the worker must act on the affected row count:

```sql
UPDATE notifications
   SET status = 'SENT', sent_at = now()
 WHERE appointment_id = $1
   AND type = 'REMINDER'
   AND status = 'PENDING'
RETURNING id;
```

Zero rows returned means another worker already sent it. The job exits
successfully without sending. This is what makes "no double reminders" a
guarantee rather than a hope.

The same conditional-update pattern applies to waiting-list entries: transition
`WAITING -> ASSIGNED` conditionally on the current status being `WAITING`.

---

# Waiting List

When an appointment is cancelled, enqueue `WAITING_LIST_PROCESS` **after the
cancellation transaction commits**.

The job payload carries the slot identity only: `doctor_id` and `slot_start_at`.
It does not carry the appointment or the chosen patient — the worker re-derives
both, so a retry always operates on current state.

Use a deterministic BullMQ job id such as `waitlist:{doctorId}:{slotStartAtIso}`
so duplicate **in-flight** enqueues for the same slot collapse into one job.

The sweeper must **not** reuse that id. BullMQ ignores `add` while a job id still
exists in the completed or failed set (`removeOnComplete.age` is an hour), so a
second cancellation of the same slot — or a waiter the first job found nobody
for — would otherwise be a silent no-op. The sweeper uses a bucketed id
(`waitlist-sweep:{doctorId}:{slotStartAtIso}:{minute}`), the same pattern as
reminder recovery. Duplicate assignment is prevented by `WAITING → ASSIGNED`
conditional update, not by the job id.

The worker selects candidates with `FOR UPDATE SKIP LOCKED`, so two workers
processing the same slot never pick the same waiting patient:

```sql
SELECT * FROM waiting_list
 WHERE doctor_id = $1
   AND slot_start_at = $2
   AND status = 'WAITING'
   AND (expires_at IS NULL OR expires_at > now())
 ORDER BY created_at
 FOR UPDATE SKIP LOCKED
 LIMIT 1;
```

The appointment insert relies on the same `appointments_no_overlap` constraint as
normal booking. If the slot was taken in the meantime by a direct booking, the
insert is rejected and the job stops without overwriting anything.

Full assignment flow is in `docs/FEATURES/WaitingList.md`.

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