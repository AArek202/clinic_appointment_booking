# Waiting List

## Goal

If a requested slot is already booked, a patient can join a waiting list.

When the appointment is cancelled, a background job processes the queue.

---

# Decided Model: FIFO Auto-Assignment

When a slot is freed, the earliest eligible waiting patient is **booked directly**.
They do not have to confirm.

## Assumptions (to be repeated in the README)

1. Queue order is FIFO by `created_at`. Earliest entry wins.
2. There is no priority tier. Seniority and patient history do
   not affect ordering.
3. A patient may hold at most one active (`WAITING`) entry per slot. Enforced by
   a partial unique index, not just an application check.
4. A patient may join the waiting list for several different slots.
5. A patient cannot join the waiting list for a slot they already have a
   CONFIRMED appointment for.
6. A patient cannot join the waiting list for a slot that is actually available —
   they are told to book it instead.
7. Entries expire when the slot's start time passes, or at an explicit
   `expires_at` if the patient set one. Expired entries are skipped and marked
   EXPIRED by the sweeper.
8. Assignment is asynchronous, via BullMQ, never inside the cancellation request.
9. Assignment is transactional and safe to retry.
10. An assigned appointment is recorded with `created_from = 'WAITING_LIST'`.
11. The assigned patient gets their own REMINDER notification, scheduled exactly
    like a directly booked appointment.
12. Notification is a `notifications` row of type `WAITLIST_ASSIGNED` plus a log
    line. No real email/SMS.

## Alternative considered: offer-with-hold

The freed slot would be reserved for the first waiter for a claim window (for
example 30 minutes), and they would have to confirm. On expiry it would pass to
the next person.

This is closer to how a real clinic behaves, and it avoids booking someone into
an appointment they never re-consented to.

Rejected for this task because it introduces a third writer competing for every
slot — the direct booker, the hold claimer and the hold-expiry job — plus a
`PENDING_CLAIM` appointment state that the overlap constraint must also cover,
plus a re-offer chain. That is roughly double the waiting-list work and most of
the remaining bug surface, for a feature the task explicitly leaves open.

Documented in the README as the considered alternative and the natural next step.

---

# Queue Processing

Cancellation should enqueue:

WAITING_LIST_PROCESS

The HTTP request must not synchronously assign the next patient.

---

# Assignment

The worker receives only the slot identity (`doctor_id`, `slot_start_at`) and
re-derives everything else, so a retry always acts on current state.

Inside one transaction:

1. Confirm the slot is genuinely free (no CONFIRMED appointment overlapping it).
   If it is taken, exit successfully — a direct booking won the race.
2. Select eligible `WAITING` entries with
   `ORDER BY created_at ... FOR UPDATE SKIP LOCKED`, so two workers can never
   pick the same patient.
3. Walk the candidates in order. For each one:
   - Skip if the patient already holds a CONFIRMED appointment overlapping this
     slot. They cannot be in two places at once.
   - Otherwise insert the appointment with `created_from = 'WAITING_LIST'`.
4. Transition the winning entry `WAITING -> ASSIGNED` with a conditional update,
   acting on the affected row count.
5. Insert the REMINDER notification row for the new appointment, and a
   `WAITLIST_ASSIGNED` notification row.
6. Commit.

After commit, enqueue the delayed reminder job for the new appointment.

If no eligible entry exists, the job exits successfully. An empty queue is not an
error.

## Handling a rejected insert

Both appointment exclusion constraints raise SQLSTATE `23P01`, so the job must
branch on the **constraint name**:

- `appointments_no_overlap` — the doctor's slot was taken by a direct booking
  while the job was running. Roll back and exit successfully. No retry can help,
  and the queue entries stay `WAITING` for a future cancellation.
- `appointments_patient_no_overlap` — this candidate is busy elsewhere at that
  time. The slot is still free. Move to the next candidate.

The eligibility check in step 3 makes the second case rare, but it cannot be
eliminated: the patient could book a conflicting appointment between the check
and the insert. The constraint is the backstop.

Because an error aborts a PostgreSQL transaction, each candidate attempt runs
inside a `SAVEPOINT`. A rejected candidate rolls back to the savepoint and the
loop continues; it does not lose the work already done in the transaction.

The candidate loop is bounded at 10 attempts, so a pathological queue cannot make
one job run unboundedly long while holding row locks. If every candidate is
ineligible, the job exits successfully and leaves the slot open — the sweeper
will retry it, and by then the conflicting appointments may have changed.

Skipped candidates stay `WAITING`. They are not marked as anything: being busy
now says nothing about their eligibility for a future opening, and the entry
expires on its own when the slot time passes.

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

Decided policy:

- An entry always expires implicitly once `slot_start_at` has passed. A waiting
  list for an appointment in the past is meaningless.
- A patient may optionally set `expires_at` ("stop waiting after Friday").
  `expires_at` must be before `slot_start_at`.
- Expired entries are skipped by the assignment job and marked EXPIRED by the
  reconciliation sweeper.

Marking is done by the sweeper rather than by a per-entry delayed job, because
expiry has no side effects and does not need to be timely to the second. One
periodic query is simpler than thousands of scheduled jobs.

---

# Notification

No real email/SMS is required.

A `notifications` row of type `WAITLIST_ASSIGNED` plus a log line is sufficient.
The row makes the behaviour observable in the database during the demo and gives
the job its idempotency key.