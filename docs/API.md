# API Surface

REST, JSON request and response bodies.

This file owns the endpoint contracts. Transaction internals and business rules
live in the feature docs under `FEATURES/`, and are cross-referenced rather than
repeated.

---

# Conventions

## Authentication

All endpoints except `POST /auth/register`, `POST /auth/login` and `GET /health`
require `Authorization: Bearer <jwt>`.

The JWT payload carries `sub` (user id) and `role`. It does not carry
`doctorId` or `patientId` — those are resolved from the user id, so a stale token
cannot assert a profile the user no longer owns.

## Time in payloads

- **Instants** (`startAt`, `endAt`, `cancelledAt`, `expiresAt`) are ISO 8601 in
  UTC with a `Z` suffix, for example `2026-09-06T07:00:00Z`.
- **Calendar dates** (availability `from` / `to`, analytics `year` / `month`) are
  interpreted in `CLINIC_TZ`, not UTC.

The distinction is deliberate. A patient browsing "September 6th" means the
clinic's September 6th, but an appointment is an unambiguous moment in time.

## Status codes

- `400` — validation failure, slot not on the doctor's grid, date range too large
- `401` — missing or invalid token
- `403` — role or ownership check failed
- `404` — doctor, appointment or waiting-list entry not found
- `409` — state conflict: slot already booked, already queued, cancellation
  window passed, email already registered
- `500` — anything else, including unexpected constraint violations

## Error body

```json
{
  "statusCode": 409,
  "code": "SLOT_ALREADY_BOOKED",
  "message": "This slot has just been booked by another patient."
}
```

The machine-readable `code` matters because several distinct conditions share
status `409`. Tests and the concurrency script assert on `code`, not on message
text. Defined codes:

`SLOT_ALREADY_BOOKED`, `PATIENT_ALREADY_BOOKED`, `SLOT_NOT_ON_GRID`,
`SLOT_OUTSIDE_SCHEDULE`, `SLOT_BLOCKED`, `CANCELLATION_WINDOW_PASSED`,
`ALREADY_IN_WAITING_LIST`, `SLOT_IS_AVAILABLE`, `DATE_RANGE_TOO_LARGE`,
`NOT_APPOINTMENT_OWNER`, `EMAIL_ALREADY_REGISTERED`, `SCHEDULE_OVERLAP`,
`BLOCK_OVERLAP`.

`SLOT_ALREADY_BOOKED` and `PATIENT_ALREADY_BOOKED` both originate from SQLSTATE
`23P01` but from differently named constraints, and they mean different things —
the doctor's slot is gone, versus the caller is busy elsewhere at that time.

---

# Endpoints

## Auth

```text
POST   /auth/register          public
POST   /auth/login             public
GET    /auth/me                any authenticated
```

`register` always creates a PATIENT. The role is never read from the request
body — otherwise anyone could register as ADMIN. See `FEATURES/Auth.md`.

## Doctors

```text
POST   /doctors                ADMIN
GET    /doctors                any authenticated
GET    /doctors/:id            any authenticated
```

`POST /doctors` creates the user account (role DOCTOR) and the doctor profile in
one transaction. Doctors do not self-register.

`GET /doctors` and `GET /doctors/:id` include `firstName` and `lastName` from
the linked user. The profile itself stores specialization and achievements.

## Schedules

```text
GET    /doctors/:doctorId/schedules            any authenticated
POST   /doctors/:doctorId/schedules            ADMIN or owning doctor
PATCH  /doctors/:doctorId/schedules/:id        ADMIN or owning doctor
DELETE /doctors/:doctorId/schedules/:id        ADMIN or owning doctor
```

Nested under the doctor so the ownership guard has an explicit subject to check.
`slot_duration_minutes` is per schedule row, not per doctor.

Two schedule rows for the same doctor and weekday may not overlap. The rejection
is `409 SCHEDULE_OVERLAP` and carries `conflictingScheduleId`. It is enforced in
the service layer because PostgreSQL has no built-in range type over `time`; see
"Known gap: overlapping schedule rows" in `docs/DATABASE.md`.

## Blocks

```text
GET    /doctors/:doctorId/blocks               any authenticated
POST   /doctors/:doctorId/blocks               ADMIN or owning doctor
DELETE /doctors/:doctorId/blocks/:id           ADMIN or owning doctor
```

A block marks a period when the doctor is unavailable, whether planned (vacation)
or unexpected (emergency, illness, an urgent hospital case). It prevents new
bookings in that period and does not alter appointments already confirmed.

A doctor's blocks may not overlap each other; the rejection is
`409 BLOCK_OVERLAP`. The bound is half-open, so a block starting exactly when
another ends is accepted. Enforced by the `blocks_no_overlap` exclusion
constraint, so it holds regardless of who writes to the table.

## Availability

```text
GET    /doctors/:doctorId/availability?from=YYYY-MM-DD&to=YYYY-MM-DD
       any authenticated
```

Dates are clinic-local. Range capped at 62 days, otherwise `400
DATE_RANGE_TOO_LARGE`.

Response is a flat list of slots, each with `startAt` and `endAt` as UTC
instants. Availability is informational only — it reserves nothing. See
`FEATURES/Availability.md`.

## Appointments

```text
POST   /appointments                           PATIENT
GET    /appointments/me                        PATIENT
GET    /doctors/:doctorId/appointments         ADMIN or owning doctor
POST   /appointments/:id/cancel                PATIENT (owner) or ADMIN
```

`GET /doctors/:doctorId/appointments` is the doctor's calendar. It includes
`patientId`, returns CONFIRMED and CANCELLED rows, and uses
`DoctorOwnershipGuard` — a patient or another doctor gets `403`.

Cancel is a POST to a sub-resource rather than `DELETE /appointments/:id`. The
row is retained with status CANCELLED for analytics, so a `DELETE` verb would
advertise the opposite of what happens.

## Waiting list

```text
POST   /waiting-list                           PATIENT
GET    /waiting-list/me                        PATIENT
DELETE /waiting-list/:id                       PATIENT (owner)
```

`DELETE` is correct here: leaving the queue is a real removal, not a state
transition worth preserving.

## Analytics

```text
GET    /doctors/:doctorId/analytics?year=YYYY&month=M
       ADMIN or owning doctor
```

See `FEATURES/Analytics.md`.

## Health

```text
GET    /health                 public
```

Not decoration. nginx uses it to route only to ready replicas, and
`docker-compose` uses it for `depends_on: service_healthy` so the app does not
start accepting traffic before migrations have run.

---

# Booking Contract

## Request

```json
POST /appointments
{
  "doctorId": "uuid",
  "startAt": "2026-09-06T07:00:00Z"
}
```

**`endAt` is never accepted from the client.** The server derives it from the
`slot_duration_minutes` of the schedule row matching that weekday.

This is a correctness decision, not a convenience one. A client that could supply
`endAt` could craft a 5-minute appointment inside a 30-minute slot. The exclusion
constraint would still prevent overlap, so nothing would break loudly — but the
slot grid would rot, and availability listings would gradually stop
corresponding to reality.

Likewise, the patient is taken from the JWT, never from the body. A patient
cannot book on behalf of someone else.

## Flow

1. Doctor exists.
2. Find the schedule row for `startAt`'s weekday, in clinic-local time.
3. `startAt` sits exactly on a slot boundary generated by that row
   (`400 SLOT_NOT_ON_GRID` otherwise).
4. Derive `endAt`.
5. `startAt` is in the future.
6. No overlapping block (`409 SLOT_BLOCKED`).
7. Caller holds no overlapping CONFIRMED appointment
   (`409 PATIENT_ALREADY_BOOKED`).
8. Transaction: insert appointment + PENDING reminder notification.
9. On SQLSTATE `23P01`: roll back, and map by constraint name —
   `appointments_no_overlap` to `SLOT_ALREADY_BOOKED`,
   `appointments_patient_no_overlap` to `PATIENT_ALREADY_BOOKED`.
10. After commit: enqueue the delayed reminder job.

Steps 1–7 exist for good error messages. Step 9 is the actual guarantee. See
`INFRASTRUCTURE/Concurrency.md`.

## Conflict response

```json
{
  "statusCode": 409,
  "code": "SLOT_ALREADY_BOOKED",
  "message": "This slot has just been booked by another patient.",
  "waitingListAvailable": true
}
```

The extra field is cheap and turns a dead end into the entry point for the
waiting-list flow — useful for a real client, and it makes the demo move
naturally from booking into the waiting list.

---

# Cancellation Contract

## Request

```text
POST /appointments/:id/cancel
```

No body. The appointment id is the whole request.

## Flow

1. Appointment exists (`404`).
2. Caller owns it, or is ADMIN (`403 NOT_APPOINTMENT_OWNER`).
3. `startAt - Clock.now() >= 2 hours`, otherwise
   `409 CANCELLATION_WINDOW_PASSED`.
4. Conditional `UPDATE ... WHERE id = $1 AND status = 'CONFIRMED'`.
5. Zero rows affected: already cancelled — return the current state with `200`,
   not an error.
6. After commit: best-effort remove the reminder job, then enqueue
   `WAITING_LIST_PROCESS`.

Step 5 is what makes a retried cancel request safe, which matters because clients
retry on timeouts.

The 2-hour window uses `409` rather than `400` because the request itself is
well-formed — it is the resource's state that refuses it. This matches the
existing rule in `DEVELOPMENT.md` to use `ConflictException` for state conflicts.

See `FEATURES/Appointments.md` for the transaction detail.

---

# Waiting List Contract

## Request

```json
POST /waiting-list
{
  "doctorId": "uuid",
  "slotStartAt": "2026-09-06T07:00:00Z",
  "expiresAt": "2026-09-05T21:00:00Z"
}
```

`expiresAt` is optional and must be before `slotStartAt`.

Rejections:

- The slot is actually free -> `409 SLOT_IS_AVAILABLE` ("book it instead").
- The patient already has an active entry -> `409 ALREADY_IN_WAITING_LIST`,
  enforced by the partial unique index rather than a prior `SELECT`.
- The slot is not on the doctor's grid -> `400 SLOT_NOT_ON_GRID`.

The response includes the patient's queue position, computed as the count of
earlier `WAITING` entries for that slot. Position is derived on read, never
stored — a stored position would need renumbering on every removal.

See `FEATURES/WaitingList.md`.
