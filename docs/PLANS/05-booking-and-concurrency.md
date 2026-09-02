# Booking, Cancellation & Concurrency Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Patients can book and cancel appointments, and it is *impossible* for
two confirmed appointments to overlap for the same doctor — proven by a script
firing concurrent requests at multiple API replicas behind a load balancer.

**Architecture:** Two layers of protection. The application snaps every booking
to the doctor's slot grid and derives `end_at` server-side; PostgreSQL then
enforces non-overlap with partial GiST exclusion constraints. The insert is
attempted and its failure handled — never `SELECT`-then-decide-then-`INSERT`,
because that gap *is* the race.

**Tech Stack:** NestJS 11, TypeORM, PostgreSQL 16 with `btree_gist`, nginx,
Docker Compose, Jest 30, Supertest.

## Global Constraints

- `synchronize: true` is forbidden everywhere. (`docs/STACK.md`)
- Names come from `docs/PLANS/00-interfaces.md`, which wins on any conflict.
- Enums are stored as `text` with a `CHECK` constraint.
- Range bounds are **`'[)'`** — half-open. Inclusive-inclusive bounds would make
  back-to-back slots (10:00–10:30 and 10:30–11:00) collide, rejecting every
  consecutive booking. (`docs/DATABASE.md`)
- Exclusion constraints are **partial** (`WHERE status = 'CONFIRMED'`), because
  cancelled rows are retained for analytics and must not block rebooking.
- Cancelled appointments are never deleted. (`docs/FEATURES/Appointments.md`)
- Error mapping branches on **constraint name**, never on SQLSTATE alone. Both
  appointment exclusion constraints raise `23P01` while meaning different things.
  (`docs/INFRASTRUCTURE/Concurrency.md`)
- `CANCELLATION_WINDOW_HOURS = 2`, `REMINDER_LEAD_HOURS = 24` from
  `src/common/constants.ts`.
- All time comes from the injected `Clock`, never `new Date()`.
- Commit messages follow `docs/DEVELOPMENT.md`.

---

## File Structure

**Created:**

```text
src/common/enums/appointment-status.enum.ts
src/common/enums/appointment-source.enum.ts
src/common/errors/database-error.ts

src/appointments/
  appointment.entity.ts
  appointments.repository.ts
  appointments.service.ts
  appointments.controller.ts
  appointments.module.ts
  dto/create-appointment.dto.ts

src/database/migrations/1756800300000-CreateAppointments.ts

nginx/nginx.conf
scripts/concurrency-test.ts

test/appointments.e2e-spec.ts
```

**Modified:** `src/app.module.ts`, `src/availability/availability.repository.ts`
(replacing the Plan 4 stub), `docker-compose.yml`, `package.json`.

---

## Task 1: The appointments table and its constraints

This is the single most important migration in the project.

**Files:**
- Create: `src/common/enums/appointment-status.enum.ts`
- Create: `src/common/enums/appointment-source.enum.ts`
- Create: `src/appointments/appointment.entity.ts`
- Create: `src/database/migrations/1756800300000-CreateAppointments.ts`

**Interfaces:**
- Consumes: `btree_gist` (Plan 1), `doctors` and `patients` tables (Plan 2),
  `src/common/constants.ts` (Plan 3 — see the note below).
- Produces: `AppointmentStatus`, `AppointmentSource`, `Appointment` entity;
  table `appointments`; constraints `appointments_time_valid`,
  `appointments_no_overlap`, `appointments_patient_no_overlap`; indexes
  `appointments_patient_start_idx`, `appointments_doctor_start_idx`.

**Do not create `src/common/constants.ts`.** Plan 3 Task 1 creates it whole,
including `CANCELLATION_WINDOW_HOURS = 2` and `REMINDER_LEAD_HOURS = 24`, which
are unused until this plan and Plan 6. Import them; do not redefine them. If the
file is missing, Plan 3 was skipped — go back and do it rather than adding a
second copy.

- [ ] **Step 1: Create the enums**

```ts
// src/common/enums/appointment-status.enum.ts
export enum AppointmentStatus {
  Confirmed = 'CONFIRMED',
  Cancelled = 'CANCELLED',
}
```

```ts
// src/common/enums/appointment-source.enum.ts
export enum AppointmentSource {
  Direct = 'DIRECT',
  WaitingList = 'WAITING_LIST',
}
```

Verify the constants exist rather than assuming:

```bash
grep -n "CANCELLATION_WINDOW_HOURS\|REMINDER_LEAD_HOURS" src/common/constants.ts
```

Expected: both constants present, from Plan 3.

- [ ] **Step 2: Create the entity**

```ts
// src/appointments/appointment.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AppointmentSource } from '../common/enums/appointment-source.enum';
import { AppointmentStatus } from '../common/enums/appointment-status.enum';

@Entity('appointments')
export class Appointment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'doctor_id', type: 'uuid' })
  doctorId!: string;

  @Column({ name: 'patient_id', type: 'uuid' })
  patientId!: string;

  @Column({ name: 'start_at', type: 'timestamptz' })
  startAt!: Date;

  @Column({ name: 'end_at', type: 'timestamptz' })
  endAt!: Date;

  @Column({ type: 'text' })
  status!: AppointmentStatus;

  @Column({ name: 'created_from', type: 'text', default: AppointmentSource.Direct })
  createdFrom!: AppointmentSource;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;
}
```

- [ ] **Step 3: Write the migration**

```ts
// src/database/migrations/1756800300000-CreateAppointments.ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAppointments1756800300000 implements MigrationInterface {
  name = 'CreateAppointments1756800300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE appointments (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        doctor_id    uuid NOT NULL REFERENCES doctors (id) ON DELETE RESTRICT,
        patient_id   uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
        start_at     timestamptz NOT NULL,
        end_at       timestamptz NOT NULL,
        status       text NOT NULL,
        created_from text NOT NULL DEFAULT 'DIRECT',
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now(),
        cancelled_at timestamptz,
        CONSTRAINT appointments_time_valid CHECK (end_at > start_at),
        CONSTRAINT appointments_status_valid
          CHECK (status IN ('CONFIRMED', 'CANCELLED')),
        CONSTRAINT appointments_created_from_valid
          CHECK (created_from IN ('DIRECT', 'WAITING_LIST'))
      )
    `);

    // The booking invariant. Two CONFIRMED appointments for one doctor may
    // never overlap in time. Stated as overlap, not equal start time: slot
    // duration lives per schedule row and may change without rewriting
    // history, so a 30-minute appointment at 10:00 can coexist with a new
    // 15-minute booking at 10:15 -- distinct start times, real overlap.
    // '[)' is half-open so back-to-back slots do not collide.
    // Partial, so cancelled rows do not block rebooking.
    await queryRunner.query(`
      ALTER TABLE appointments
        ADD CONSTRAINT appointments_no_overlap
        EXCLUDE USING gist (
          doctor_id WITH =,
          tstzrange(start_at, end_at, '[)') WITH &&
        ) WHERE (status = 'CONFIRMED')
    `);

    // A patient cannot attend two appointments at once either.
    await queryRunner.query(`
      ALTER TABLE appointments
        ADD CONSTRAINT appointments_patient_no_overlap
        EXCLUDE USING gist (
          patient_id WITH =,
          tstzrange(start_at, end_at, '[)') WITH &&
        ) WHERE (status = 'CONFIRMED')
    `);

    // "List my appointments" and the ownership check on cancel.
    await queryRunner.query(`
      CREATE INDEX appointments_patient_start_idx
        ON appointments (patient_id, start_at)
    `);

    // Monthly analytics, which must count CANCELLED rows and therefore
    // cannot use the partial exclusion index.
    await queryRunner.query(`
      CREATE INDEX appointments_doctor_start_idx
        ON appointments (doctor_id, start_at)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE appointments`);
  }
}
```

`DROP TABLE` removes the constraints and indexes with it, so `down` needs
nothing more.

- [ ] **Step 4: Run the migration**

```bash
npm run migration:run
docker compose exec postgres psql -U clinic -d clinic -c "\d appointments"
```

Expected: both `EXCLUDE USING gist` constraints appear under "Indexes", each with
`WHERE (status = 'CONFIRMED')`.

- [ ] **Step 5: Prove the constraint works, in raw SQL, before writing any code**

```bash
docker compose exec postgres psql -U clinic -d clinic
```

```sql
-- Replace the ids with real ones from your doctors/patients tables.
INSERT INTO appointments (doctor_id, patient_id, start_at, end_at, status)
VALUES ('<doctor>', '<patient-a>', '2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z', 'CONFIRMED');

-- Overlapping, same doctor, different patient: must fail with 23P01.
INSERT INTO appointments (doctor_id, patient_id, start_at, end_at, status)
VALUES ('<doctor>', '<patient-b>', '2026-10-05T10:15:00Z', '2026-10-05T10:45:00Z', 'CONFIRMED');

-- Back-to-back, same doctor: must SUCCEED. This is the '[)' bound working.
INSERT INTO appointments (doctor_id, patient_id, start_at, end_at, status)
VALUES ('<doctor>', '<patient-b>', '2026-10-05T10:30:00Z', '2026-10-05T11:00:00Z', 'CONFIRMED');

-- Cancel the first, then rebook the same slot: must SUCCEED.
UPDATE appointments SET status = 'CANCELLED', cancelled_at = now()
 WHERE start_at = '2026-10-05T10:00:00Z';
INSERT INTO appointments (doctor_id, patient_id, start_at, end_at, status)
VALUES ('<doctor>', '<patient-c>', '2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z', 'CONFIRMED');
```

Expected: insert 1 succeeds, insert 2 fails with
`conflicting key value violates exclusion constraint "appointments_no_overlap"`,
insert 3 succeeds, insert 4 succeeds. Clean up with
`DELETE FROM appointments;` afterwards.

Do this by hand before writing application code. If the constraint does not
behave exactly this way, no amount of TypeScript will fix it.

- [ ] **Step 6: Verify revert and re-run**

```bash
npm run migration:revert
npm run migration:run
```

- [ ] **Step 7: Commit**

```bash
git add src/common src/appointments/appointment.entity.ts src/database/migrations
git commit -m "feat(appointments): add appointments table with overlap exclusion constraints"
```

---

## Task 2: Database error helpers

**Files:**
- Create: `src/common/errors/database-error.ts`
- Test: `src/common/errors/database-error.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PG_UNIQUE_VIOLATION`, `PG_EXCLUSION_VIOLATION`, `getSqlState`,
  `getConstraintName`, `isConstraintViolation`. Plans 6 and 7 use these.

- [ ] **Step 1: Write the failing test**

```ts
// src/common/errors/database-error.spec.ts
import { QueryFailedError } from 'typeorm';
import {
  getConstraintName,
  getSqlState,
  isConstraintViolation,
  PG_EXCLUSION_VIOLATION,
} from './database-error';

/** Shape of a real pg driver error, as TypeORM wraps it. */
function pgError(code: string, constraint: string): QueryFailedError {
  const driverError = Object.assign(new Error('conflicting key value'), { code, constraint });
  return new QueryFailedError('INSERT ...', [], driverError);
}

describe('database error helpers', () => {
  it('extracts the SQLSTATE', () => {
    expect(getSqlState(pgError('23P01', 'appointments_no_overlap'))).toBe('23P01');
  });

  it('extracts the constraint name', () => {
    expect(getConstraintName(pgError('23P01', 'appointments_no_overlap'))).toBe(
      'appointments_no_overlap',
    );
  });

  it('matches a specific constraint', () => {
    const error = pgError(PG_EXCLUSION_VIOLATION, 'appointments_no_overlap');

    expect(isConstraintViolation(error, 'appointments_no_overlap')).toBe(true);
  });

  it('does not confuse the two appointment exclusion constraints', () => {
    const patientConflict = pgError(
      PG_EXCLUSION_VIOLATION,
      'appointments_patient_no_overlap',
    );

    expect(isConstraintViolation(patientConflict, 'appointments_no_overlap')).toBe(false);
    expect(isConstraintViolation(patientConflict, 'appointments_patient_no_overlap')).toBe(
      true,
    );
  });

  it('returns undefined for a non-database error', () => {
    expect(getSqlState(new Error('nope'))).toBeUndefined();
    expect(getConstraintName(new Error('nope'))).toBeUndefined();
  });
});
```

The fourth test is the whole point of this file. Both constraints raise `23P01`,
so anything branching on SQLSTATE alone would report "slot already booked" when
the real problem is that the patient is busy elsewhere.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/common/errors/database-error.spec.ts`
Expected: FAIL — `Cannot find module './database-error'`.

- [ ] **Step 3: Implement the helpers**

```ts
// src/common/errors/database-error.ts

/** Unique constraint violated. */
export const PG_UNIQUE_VIOLATION = '23505';

/** Exclusion constraint violated. */
export const PG_EXCLUSION_VIOLATION = '23P01';

interface DriverErrorShape {
  code?: string;
  constraint?: string;
}

function driverError(error: unknown): DriverErrorShape | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  // TypeORM wraps the pg error; some paths surface it directly.
  const candidate = (error as { driverError?: unknown }).driverError ?? error;
  if (typeof candidate !== 'object' || candidate === null) {
    return undefined;
  }

  return candidate as DriverErrorShape;
}

export function getSqlState(error: unknown): string | undefined {
  return driverError(error)?.code;
}

export function getConstraintName(error: unknown): string | undefined {
  return driverError(error)?.constraint;
}

/**
 * True when the error is a violation of the named constraint.
 *
 * Callers must use this rather than checking SQLSTATE alone:
 * appointments_no_overlap and appointments_patient_no_overlap both raise
 * 23P01 but mean different things. See docs/INFRASTRUCTURE/Concurrency.md.
 */
export function isConstraintViolation(error: unknown, constraint: string): boolean {
  const details = driverError(error);
  if (!details?.code) {
    return false;
  }

  const isViolation =
    details.code === PG_UNIQUE_VIOLATION || details.code === PG_EXCLUSION_VIOLATION;

  return isViolation && details.constraint === constraint;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/common/errors/database-error.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/common/errors/database-error.ts src/common/errors/database-error.spec.ts
git commit -m "feat(common): add PostgreSQL constraint error helpers"
```

---

## Task 3: The appointments repository

**Files:**
- Create: `src/appointments/appointments.repository.ts`

**Interfaces:**
- Consumes: `Appointment` entity.
- Produces: `AppointmentsRepository` with `insertConfirmed(params, manager?)`,
  `findById`, `cancelIfConfirmed`, `findOverlappingForPatient`,
  `findBookedRanges`, `listForPatient`, `listForDoctor`. Plan 4's availability
  repository calls `findBookedRanges`; Plan 7's processor calls
  `insertConfirmed` with a manager.

- [ ] **Step 1: Implement the repository**

```ts
// src/appointments/appointments.repository.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AppointmentSource } from '../common/enums/appointment-source.enum';
import { AppointmentStatus } from '../common/enums/appointment-status.enum';
import { Appointment } from './appointment.entity';

export interface InsertConfirmedParams {
  doctorId: string;
  patientId: string;
  startAt: Date;
  endAt: Date;
  createdFrom: AppointmentSource;
}

export interface BookedRange {
  startAt: Date;
  endAt: Date;
}

@Injectable()
export class AppointmentsRepository {
  constructor(
    @InjectRepository(Appointment) private readonly repo: Repository<Appointment>,
  ) {}

  /**
   * Inserts a CONFIRMED appointment.
   *
   * Deliberately does NOT catch constraint violations: callers must branch on
   * the constraint name, and swallowing the error here would destroy that
   * information.
   */
  insertConfirmed(
    params: InsertConfirmedParams,
    manager?: EntityManager,
  ): Promise<Appointment> {
    const repo = manager ? manager.getRepository(Appointment) : this.repo;
    return repo.save(
      repo.create({
        ...params,
        status: AppointmentStatus.Confirmed,
        cancelledAt: null,
      }),
    );
  }

  findById(id: string): Promise<Appointment | null> {
    return this.repo.findOne({ where: { id } });
  }

  /**
   * Conditional cancel. Returns the number of rows affected: 0 means it was
   * already cancelled, which makes a retried cancel request safe.
   */
  async cancelIfConfirmed(id: string, cancelledAt: Date): Promise<number> {
    const result = await this.repo
      .createQueryBuilder()
      .update(Appointment)
      .set({ status: AppointmentStatus.Cancelled, cancelledAt })
      .where('id = :id AND status = :status', {
        id,
        status: AppointmentStatus.Confirmed,
      })
      .execute();

    return result.affected ?? 0;
  }

  /** Pre-check for a friendly error. The constraint is the real guarantee. */
  findOverlappingForPatient(
    patientId: string,
    startAt: Date,
    endAt: Date,
    manager?: EntityManager,
  ): Promise<Appointment | null> {
    const repo = manager ? manager.getRepository(Appointment) : this.repo;
    return repo
      .createQueryBuilder('a')
      .where('a.patient_id = :patientId', { patientId })
      .andWhere('a.status = :status', { status: AppointmentStatus.Confirmed })
      .andWhere('a.start_at < :endAt AND a.end_at > :startAt', { startAt, endAt })
      .getOne();
  }

  /**
   * Confirmed appointments overlapping the window, for availability listing.
   * Served by the appointments_no_overlap GiST index.
   */
  async findBookedRanges(
    doctorId: string,
    fromAt: Date,
    toAt: Date,
  ): Promise<BookedRange[]> {
    return this.repo
      .createQueryBuilder('a')
      .select(['a.start_at AS "startAt"', 'a.end_at AS "endAt"'])
      .where('a.doctor_id = :doctorId', { doctorId })
      .andWhere('a.status = :status', { status: AppointmentStatus.Confirmed })
      .andWhere('a.start_at < :toAt AND a.end_at > :fromAt', { fromAt, toAt })
      .orderBy('a.start_at', 'ASC')
      .getRawMany<BookedRange>();
  }

  listForPatient(patientId: string): Promise<Appointment[]> {
    return this.repo.find({ where: { patientId }, order: { startAt: 'DESC' } });
  }

  listForDoctor(doctorId: string): Promise<Appointment[]> {
    return this.repo.find({ where: { doctorId }, order: { startAt: 'ASC' } });
  }
}
```

Note the overlap predicate `start_at < :endAt AND end_at > :startAt`. That is the
half-open overlap test, and it must agree with the `'[)'` bound in the
constraint. Using `<=` / `>=` here would report back-to-back appointments as
overlapping and hide available slots.

- [ ] **Step 2: Commit**

```bash
git add src/appointments/appointments.repository.ts
git commit -m "feat(appointments): add appointments repository"
```

---

## Task 4: Booking

**Files:**
- Create: `src/appointments/dto/create-appointment.dto.ts`
- Create: `src/appointments/appointments.service.ts`
- Test: `test/appointments.e2e-spec.ts` (booking cases)

**Interfaces:**
- Consumes: `resolveSlot` and `overlaps` from
  `src/availability/slot-generator.ts` (Plan 4), `SchedulesRepository` and
  `BlocksRepository` (Plan 3), `Clock` (Plan 1), `NotificationsRepository`
  (Plan 6 — see the deferral note below).
- Produces: `AppointmentsService.book(patientId, doctorId, startAt)`;
  `AppointmentsService.createFromWaitingList(manager, params)` for Plan 7.

**Plan 6 deferral:** the reminder notification row is written inside the booking
transaction, and the delayed job is enqueued after commit. Plan 6 creates
`NotificationsRepository` and the queue. Until Plan 6 lands, leave the two marked
integration points as no-op comments and do not invent the notifications table
here. Plan 6's plan states the same boundary from its side.

- [ ] **Step 1: Write the DTO**

```ts
// src/appointments/dto/create-appointment.dto.ts
import { Type } from 'class-transformer';
import { IsDate, IsUUID } from 'class-validator';

export class CreateAppointmentDto {
  @IsUUID()
  doctorId!: string;

  @Type(() => Date)
  @IsDate()
  startAt!: Date;
}
```

There is deliberately no `endAt` and no `patientId`. `endAt` is derived from the
schedule's slot duration; the patient comes from the JWT. A client able to supply
`endAt` could craft a 5-minute appointment inside a 30-minute slot — the
constraint would still prevent overlap, so nothing would fail loudly, but the
slot grid would rot and availability would drift from reality. Combined with
Plan 1's `forbidNonWhitelisted` pipe, sending either field returns 400.

- [ ] **Step 2: Add the error codes**

Confirm these exist in `src/common/errors/error-code.enum.ts` (Plan 1 created the
enum with the full documented taxonomy):
`SlotAlreadyBooked`, `PatientAlreadyBooked`, `SlotNotOnGrid`, `SlotBlocked`,
`CancellationWindowPassed`, `NotAppointmentOwner`.

- [ ] **Step 3: Write the failing booking tests**

```ts
// test/appointments.e2e-spec.ts  (booking section)
// Extend the existing test/helpers/seed.helper.ts created by Plan 3 -- do not
// start a second helper file. Add to it whatever this plan needs: a patient
// with a token, a doctor with a Monday 10:00-16:00 / 30-minute schedule, a
// second doctor for the patient-conflict case, and bookAs/cancelAs wrappers.

it('books an available slot on the grid', async () => {
  const response = await request(app.getHttpServer())
    .post('/appointments')
    .set('Authorization', `Bearer ${patientToken}`)
    .send({ doctorId, startAt: '2026-10-05T07:00:00.000Z' })
    .expect(201);

  expect(response.body).toEqual({
    id: expect.any(String),
    doctorId,
    startAt: '2026-10-05T07:00:00.000Z',
    endAt: '2026-10-05T07:30:00.000Z',
    status: 'CONFIRMED',
    createdFrom: 'DIRECT',
  });
});

it('derives endAt from the schedule and ignores a client-supplied endAt', async () => {
  await request(app.getHttpServer())
    .post('/appointments')
    .set('Authorization', `Bearer ${patientToken}`)
    .send({
      doctorId,
      startAt: '2026-10-05T07:00:00.000Z',
      endAt: '2026-10-05T07:05:00.000Z',
    })
    .expect(400);
});

it('rejects a slot that is not on the grid', async () => {
  const response = await request(app.getHttpServer())
    .post('/appointments')
    .set('Authorization', `Bearer ${patientToken}`)
    .send({ doctorId, startAt: '2026-10-05T07:07:00.000Z' })
    .expect(400);

  expect(response.body.code).toBe('SLOT_NOT_ON_GRID');
});

it('rejects a slot outside the working schedule', async () => {
  const response = await request(app.getHttpServer())
    .post('/appointments')
    .set('Authorization', `Bearer ${patientToken}`)
    .send({ doctorId, startAt: '2026-10-05T20:00:00.000Z' })
    .expect(400);

  expect(response.body.code).toBe('SLOT_NOT_ON_GRID');
});

it('rejects a slot covered by a block', async () => {
  await createBlock(doctorId, '2026-10-05T07:00:00Z', '2026-10-05T08:00:00Z');

  const response = await request(app.getHttpServer())
    .post('/appointments')
    .set('Authorization', `Bearer ${patientToken}`)
    .send({ doctorId, startAt: '2026-10-05T07:00:00.000Z' })
    .expect(409);

  expect(response.body.code).toBe('SLOT_BLOCKED');
});

it('rejects a second booking of the same slot with SLOT_ALREADY_BOOKED', async () => {
  await bookAs(patientToken, doctorId, '2026-10-05T07:00:00.000Z');

  const response = await request(app.getHttpServer())
    .post('/appointments')
    .set('Authorization', `Bearer ${otherPatientToken}`)
    .send({ doctorId, startAt: '2026-10-05T07:00:00.000Z' })
    .expect(409);

  expect(response.body.code).toBe('SLOT_ALREADY_BOOKED');
  expect(response.body.waitingListAvailable).toBe(true);
});

it('rejects a patient booking two overlapping slots with different doctors', async () => {
  await bookAs(patientToken, doctorId, '2026-10-05T07:00:00.000Z');

  const response = await request(app.getHttpServer())
    .post('/appointments')
    .set('Authorization', `Bearer ${patientToken}`)
    .send({ doctorId: secondDoctorId, startAt: '2026-10-05T07:00:00.000Z' })
    .expect(409);

  expect(response.body.code).toBe('PATIENT_ALREADY_BOOKED');
});

it('allows rebooking a slot after it was cancelled', async () => {
  const first = await bookAs(patientToken, doctorId, '2026-10-05T07:00:00.000Z');
  await cancelAs(patientToken, first.id);

  await request(app.getHttpServer())
    .post('/appointments')
    .set('Authorization', `Bearer ${otherPatientToken}`)
    .send({ doctorId, startAt: '2026-10-05T07:00:00.000Z' })
    .expect(201);
});

it('allows back-to-back appointments', async () => {
  await bookAs(patientToken, doctorId, '2026-10-05T07:00:00.000Z');

  await request(app.getHttpServer())
    .post('/appointments')
    .set('Authorization', `Bearer ${otherPatientToken}`)
    .send({ doctorId, startAt: '2026-10-05T07:30:00.000Z' })
    .expect(201);
});

it('rejects booking a slot in the past', async () => {
  // Clock is overridden with FixedClock at 2026-10-06T12:00:00Z in this test.
  const response = await request(app.getHttpServer())
    .post('/appointments')
    .set('Authorization', `Bearer ${patientToken}`)
    .send({ doctorId, startAt: '2026-10-05T07:00:00.000Z' })
    .expect(400);

  expect(response.body.code).toBe('SLOT_NOT_ON_GRID');
});
```

The two distinct 409 codes are the payoff from Task 2. The
`allows back-to-back` and `allows rebooking after cancel` tests are guarding
against the two easiest ways to get the constraint wrong.

`2026-10-05` is a Monday. Confirm the weekday of any date you use against the
schedule fixture rather than assuming it.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm run test:e2e -- appointments`
Expected: FAIL — `Cannot POST /appointments` (404).

- [ ] **Step 5: Implement booking**

```ts
// src/appointments/appointments.service.ts
import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { resolveSlot } from '../availability/slot-generator';
import { BlocksRepository } from '../blocks/blocks.repository';
import { Clock } from '../common/clock/clock';
import { AppointmentSource } from '../common/enums/appointment-source.enum';
import { AppException, BadRequestError, ConflictError } from '../common/errors/app.exception';
import { isConstraintViolation } from '../common/errors/database-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { SchedulesRepository } from '../schedules/schedules.repository';
import { ConfigService } from '@nestjs/config';
import { Appointment } from './appointment.entity';
import { AppointmentsRepository } from './appointments.repository';

const DOCTOR_OVERLAP = 'appointments_no_overlap';
const PATIENT_OVERLAP = 'appointments_patient_no_overlap';

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly appointments: AppointmentsRepository,
    private readonly schedules: SchedulesRepository,
    private readonly blocks: BlocksRepository,
    private readonly clock: Clock,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  async book(patientId: string, doctorId: string, startAt: Date): Promise<Appointment> {
    const timeZone = this.config.getOrThrow<string>('CLINIC_TZ');

    if (startAt.getTime() <= this.clock.now().getTime()) {
      throw new BadRequestError(
        ErrorCode.SlotNotOnGrid,
        'Appointments can only be booked in the future.',
      );
    }

    // Layer 1: snap the request to the doctor's slot grid and derive endAt.
    // Everything downstream, including availability listing and analytics,
    // assumes rows sit on a predictable grid.
    const windows = await this.schedules.findByDoctorId(doctorId);
    const slot = resolveSlot(startAt, windows, timeZone);
    if (!slot) {
      throw new BadRequestError(
        ErrorCode.SlotNotOnGrid,
        "The requested time is not one of this doctor's available slots.",
      );
    }

    // findOverlapping returns an array. Check its length -- an empty array is
    // truthy, so `if (blocking)` would reject every booking as blocked.
    const blocking = await this.blocks.findOverlapping(doctorId, slot.startAt, slot.endAt);
    if (blocking.length > 0) {
      throw new ConflictError(
        ErrorCode.SlotBlocked,
        'The doctor is unavailable at this time.',
      );
    }

    const patientConflict = await this.appointments.findOverlappingForPatient(
      patientId,
      slot.startAt,
      slot.endAt,
    );
    if (patientConflict) {
      throw new ConflictError(
        ErrorCode.PatientAlreadyBooked,
        'You already have an appointment at this time.',
      );
    }

    try {
      return await this.dataSource.transaction(async (manager) => {
        const appointment = await this.appointments.insertConfirmed(
          {
            doctorId,
            patientId,
            startAt: slot.startAt,
            endAt: slot.endAt,
            createdFrom: AppointmentSource.Direct,
          },
          manager,
        );

        // PLAN 6 INTEGRATION POINT: create the PENDING REMINDER notification
        // row here, inside this transaction, with
        // scheduledAt = startAt - REMINDER_LEAD_HOURS.
        return appointment;
      });
    } catch (error) {
      // Layer 2: the database is the final authority. Both constraints raise
      // 23P01, so branch on the name -- one means the slot is gone, the other
      // means this patient is busy elsewhere.
      if (isConstraintViolation(error, DOCTOR_OVERLAP)) {
        throw new ConflictError(
          ErrorCode.SlotAlreadyBooked,
          'This slot has just been booked by another patient.',
          { waitingListAvailable: true },
        );
      }

      if (isConstraintViolation(error, PATIENT_OVERLAP)) {
        throw new ConflictError(
          ErrorCode.PatientAlreadyBooked,
          'You already have an appointment at this time.',
        );
      }

      // Anything else is a real fault and must not be reported as a conflict.
      throw error;
    }

    // PLAN 6 INTEGRATION POINT: after the transaction commits, enqueue the
    // delayed reminder job. Never inside the transaction.
  }

  /**
   * Creates a CONFIRMED appointment from the waiting list, inside a caller's
   * transaction. Rethrows the raw error so the caller can branch on the
   * constraint name and decide whether to stop or try the next candidate.
   */
  createFromWaitingList(
    manager: EntityManager,
    params: { doctorId: string; patientId: string; startAt: Date; endAt: Date },
  ): Promise<Appointment> {
    return this.appointments.insertConfirmed(
      { ...params, createdFrom: AppointmentSource.WaitingList },
      manager,
    );
  }
}
```

Note the shape: the pre-checks produce friendly messages, and the `catch`
produces the guarantee. Deleting every pre-check would leave the system correct
but rude; deleting the `catch` would leave it polite but broken.

- [ ] **Step 6: Run the booking tests to verify they pass**

Run: `npm run test:e2e -- appointments`
Expected: all booking cases pass.

- [ ] **Step 7: Commit**

```bash
git add src/appointments test/appointments.e2e-spec.ts test/helpers/seed.helper.ts
git commit -m "feat(appointments): implement slot booking with database-enforced non-overlap"
```

---

## Task 5: Cancellation

**Files:**
- Modify: `src/appointments/appointments.service.ts`
- Modify: `test/appointments.e2e-spec.ts`

**Interfaces:**
- Produces: `AppointmentsService.cancel(appointmentId, actor: AuthUser)`.

- [ ] **Step 1: Write the failing cancellation tests**

```ts
// test/appointments.e2e-spec.ts  (cancellation section)
// The Clock provider is overridden with FixedClock in these tests:
//   .overrideProvider(Clock).useValue(new FixedClock(new Date('2026-10-05T06:00:00Z')))

it('cancels an appointment more than 2 hours ahead', async () => {
  // now = 06:00Z, appointment at 09:00Z -> 3 hours ahead
  const appointment = await bookAs(patientToken, doctorId, '2026-10-05T09:00:00.000Z');

  const response = await request(app.getHttpServer())
    .post(`/appointments/${appointment.id}/cancel`)
    .set('Authorization', `Bearer ${patientToken}`)
    .expect(200);

  expect(response.body.status).toBe('CANCELLED');
  expect(response.body.cancelledAt).not.toBeNull();
});

it('rejects cancelling less than 2 hours ahead', async () => {
  // now = 06:00Z, appointment at 07:30Z -> 1.5 hours ahead
  const appointment = await bookAs(patientToken, doctorId, '2026-10-05T07:30:00.000Z');

  const response = await request(app.getHttpServer())
    .post(`/appointments/${appointment.id}/cancel`)
    .set('Authorization', `Bearer ${patientToken}`)
    .expect(409);

  expect(response.body.code).toBe('CANCELLATION_WINDOW_PASSED');
});

it('allows cancelling at exactly 2 hours ahead', async () => {
  // now = 06:00Z, appointment at 08:00Z -> exactly 2 hours
  const appointment = await bookAs(patientToken, doctorId, '2026-10-05T08:00:00.000Z');

  await request(app.getHttpServer())
    .post(`/appointments/${appointment.id}/cancel`)
    .set('Authorization', `Bearer ${patientToken}`)
    .expect(200);
});

it("rejects cancelling another patient's appointment", async () => {
  const appointment = await bookAs(patientToken, doctorId, '2026-10-05T09:00:00.000Z');

  const response = await request(app.getHttpServer())
    .post(`/appointments/${appointment.id}/cancel`)
    .set('Authorization', `Bearer ${otherPatientToken}`)
    .expect(403);

  expect(response.body.code).toBe('NOT_APPOINTMENT_OWNER');
});

it('treats a repeated cancel as success and does not cancel twice', async () => {
  const appointment = await bookAs(patientToken, doctorId, '2026-10-05T09:00:00.000Z');

  const first = await request(app.getHttpServer())
    .post(`/appointments/${appointment.id}/cancel`)
    .set('Authorization', `Bearer ${patientToken}`)
    .expect(200);

  const second = await request(app.getHttpServer())
    .post(`/appointments/${appointment.id}/cancel`)
    .set('Authorization', `Bearer ${patientToken}`)
    .expect(200);

  // cancelledAt must not move on the second call.
  expect(second.body.cancelledAt).toBe(first.body.cancelledAt);
});

it('returns 404 for an unknown appointment', async () => {
  await request(app.getHttpServer())
    .post('/appointments/00000000-0000-0000-0000-000000000000/cancel')
    .set('Authorization', `Bearer ${patientToken}`)
    .expect(404);
});
```

The "exactly 2 hours" case pins the boundary. The repeated-cancel case is what
makes a client retrying on a timeout safe, and asserting `cancelledAt` did not
move proves the update really was conditional.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:e2e -- appointments`
Expected: FAIL — cancellation route does not exist.

- [ ] **Step 3: Implement cancellation**

Add to `AppointmentsService`:

```ts
  async cancel(appointmentId: string, actor: AuthUser): Promise<Appointment> {
    const appointment = await this.appointments.findById(appointmentId);
    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    const isOwner = actor.patientId === appointment.patientId;
    if (actor.role !== UserRole.Admin && !isOwner) {
      throw new AppException(
        ErrorCode.NotAppointmentOwner,
        'You can only cancel your own appointments.',
        HttpStatus.FORBIDDEN,
      );
    }

    if (appointment.status === AppointmentStatus.Cancelled) {
      // Idempotent: a retried request returns current state, not an error.
      return appointment;
    }

    const hoursUntil =
      (appointment.startAt.getTime() - this.clock.now().getTime()) / (60 * 60 * 1000);
    if (hoursUntil < CANCELLATION_WINDOW_HOURS) {
      throw new ConflictError(
        ErrorCode.CancellationWindowPassed,
        `Appointments cannot be cancelled less than ${CANCELLATION_WINDOW_HOURS} hours in advance.`,
      );
    }

    const affected = await this.appointments.cancelIfConfirmed(
      appointmentId,
      this.clock.now(),
    );

    if (affected === 0) {
      // Someone cancelled it between our read and our write. Not an error.
      const current = await this.appointments.findById(appointmentId);
      return current!;
    }

    // PLAN 6 INTEGRATION POINT: after commit, best-effort remove the delayed
    // reminder job, then enqueue WAITING_LIST_PROCESS for
    // (doctorId, startAt). Never inside the transaction.

    const updated = await this.appointments.findById(appointmentId);
    return updated!;
  }
```

Add the imports: `NotFoundException`, `AuthUser`, `UserRole`,
`AppointmentStatus`, `CANCELLATION_WINDOW_HOURS`.

The window check uses `< CANCELLATION_WINDOW_HOURS`, so exactly two hours is
allowed — matching the test and the worked example in
`docs/FEATURES/Appointments.md`.

- [ ] **Step 4: Implement the controller**

```ts
// src/appointments/appointments.controller.ts
import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AuthUser } from '../auth/auth-user.interface';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums/role.enum';
import { AppointmentsService } from './appointments.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';

@Controller()
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Roles(UserRole.Patient)
  @Post('appointments')
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateAppointmentDto) {
    const appointment = await this.appointments.book(user.patientId!, dto.doctorId, dto.startAt);
    return {
      id: appointment.id,
      doctorId: appointment.doctorId,
      startAt: appointment.startAt.toISOString(),
      endAt: appointment.endAt.toISOString(),
      status: appointment.status,
      createdFrom: appointment.createdFrom,
    };
  }

  @Roles(UserRole.Patient)
  @Get('appointments/me')
  async mine(@CurrentUser() user: AuthUser) {
    const appointments = await this.appointments.listForPatient(user.patientId!);
    return appointments.map((a) => ({
      id: a.id,
      doctorId: a.doctorId,
      startAt: a.startAt.toISOString(),
      endAt: a.endAt.toISOString(),
      status: a.status,
    }));
  }

  @Post('appointments/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const appointment = await this.appointments.cancel(id, user);
    return {
      id: appointment.id,
      status: appointment.status,
      cancelledAt: appointment.cancelledAt?.toISOString() ?? null,
    };
  }
}
```

`@Roles(UserRole.Patient)` on create means `user.patientId` is guaranteed
present, which is what makes the `!` assertion honest rather than hopeful.

- [ ] **Step 5: Create the module and register it**

```ts
// src/appointments/appointments.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BlocksModule } from '../blocks/blocks.module';
import { SchedulesModule } from '../schedules/schedules.module';
import { Appointment } from './appointment.entity';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsRepository } from './appointments.repository';
import { AppointmentsService } from './appointments.service';

@Module({
  imports: [TypeOrmModule.forFeature([Appointment]), SchedulesModule, BlocksModule],
  controllers: [AppointmentsController],
  providers: [AppointmentsRepository, AppointmentsService],
  exports: [AppointmentsRepository, AppointmentsService],
})
export class AppointmentsModule {}
```

Add `AppointmentsModule` to `src/app.module.ts` imports. It must **not** import
`WaitingListModule` — Plan 7's processor orchestrates that direction.

- [ ] **Step 6: Run the full suite**

```bash
npm test && npm run test:e2e
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/appointments src/app.module.ts test
git commit -m "feat(appointments): add cancellation with 2-hour window and idempotent retry"
```

---

## Task 6: Wire real booked ranges into availability

**Files:**
- Modify: `src/availability/availability.repository.ts`
- Modify: `src/availability/availability.module.ts`
- Modify: `test/availability.e2e-spec.ts`

**Interfaces:**
- Consumes: `AppointmentsRepository.findBookedRanges`.
- Produces: availability that actually excludes booked slots.

- [ ] **Step 1: Write the failing test**

Add to `test/availability.e2e-spec.ts`:

```ts
it('excludes a slot once it is booked', async () => {
  const before = await listAvailability(doctorId, '2026-10-05', '2026-10-05');
  expect(before.map((s) => s.startAt)).toContain('2026-10-05T07:00:00.000Z');

  await bookAs(patientToken, doctorId, '2026-10-05T07:00:00.000Z');

  const after = await listAvailability(doctorId, '2026-10-05', '2026-10-05');
  expect(after.map((s) => s.startAt)).not.toContain('2026-10-05T07:00:00.000Z');
  expect(after.length).toBe(before.length - 1);
});

it('shows the slot again after it is cancelled', async () => {
  const appointment = await bookAs(patientToken, doctorId, '2026-10-05T09:00:00.000Z');
  await cancelAs(patientToken, appointment.id);

  const slots = await listAvailability(doctorId, '2026-10-05', '2026-10-05');
  expect(slots.map((s) => s.startAt)).toContain('2026-10-05T09:00:00.000Z');
});
```

- [ ] **Step 2: Replace the Plan 4 stub**

In `src/availability/availability.repository.ts`, replace the method that
returned an empty array with a delegation to `AppointmentsRepository`:

```ts
  findBookedRanges(doctorId: string, fromAt: Date, toAt: Date): Promise<TimeRange[]> {
    return this.appointments.findBookedRanges(doctorId, fromAt, toAt);
  }
```

Inject `AppointmentsRepository` in the constructor and add `AppointmentsModule`
to `AvailabilityModule`'s imports.

- [ ] **Step 3: Run the tests to verify they pass**

Run: `npm run test:e2e -- availability`
Expected: PASS, including the two new cases.

- [ ] **Step 4: Commit**

```bash
git add src/availability test/availability.e2e-spec.ts
git commit -m "feat(availability): exclude booked slots from availability listing"
```

---

## Task 7: Load balancer and multiple API replicas

**Files:**
- Create: `nginx/nginx.conf`
- Modify: `docker-compose.yml`

**Interfaces:**
- Produces: the stack serving on `http://localhost:8080` through nginx, with two
  `api` replicas.

- [ ] **Step 1: Write the nginx config**

```nginx
# nginx/nginx.conf
events {}

http {
  # Docker's embedded DNS server. Required because nginx resolves a static
  # upstream name ONCE at config load: with `proxy_pass http://api:3000;`
  # every request would go to whichever single replica was resolved at start.
  # Using a variable in proxy_pass forces resolution at request time, and
  # Docker's DNS returns the replica addresses in rotation.
  resolver 127.0.0.11 valid=5s ipv6=off;

  server {
    listen 80;

    location / {
      set $upstream http://api:3000;
      proxy_pass $upstream;

      proxy_set_header Host              $host;
      proxy_set_header X-Real-IP         $remote_addr;
      proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;

      # Surface upstream errors rather than silently retrying another replica:
      # a retried POST could double-book.
      proxy_next_upstream off;
    }
  }
}
```

`proxy_next_upstream off` matters here. With retries enabled, nginx could replay
a POST against a second replica after a timeout, and the concurrency proof would
be measuring nginx rather than PostgreSQL.

- [ ] **Step 2: Scale the API and add nginx to compose**

In `docker-compose.yml`, modify the `api` service: **remove its `ports` block**
and add replicas.

```yaml
  api:
    build:
      context: .
      target: runtime
    environment:
      NODE_ENV: production
      PORT: 3000
      DATABASE_URL: postgres://clinic:clinic@postgres:5432/clinic
      REDIS_URL: redis://redis:6379
      JWT_SECRET: ${JWT_SECRET}
      JWT_EXPIRES_IN: ${JWT_EXPIRES_IN}
      CLINIC_TZ: ${CLINIC_TZ}
    # No `ports`: a published host port cannot be shared by replicas.
    # All traffic arrives through nginx.
    deploy:
      replicas: 2
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    healthcheck:
      test:
        - CMD-SHELL
        - "node -e \"fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 15s
```

Add the `nginx` service:

```yaml
  nginx:
    image: nginx:1.27-alpine
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    ports:
      - '8080:80'
    depends_on:
      api:
        condition: service_healthy
```

- [ ] **Step 3: Start the stack and confirm two replicas are running**

```bash
docker compose up --build -d
docker compose ps
```

Expected: two containers for the `api` service, both `healthy`; `nginx` running.

- [ ] **Step 4: Confirm requests reach different replicas**

```bash
docker compose logs --tail=0 --follow api
```

In another terminal:

```bash
for i in 1 2 3 4 5 6; do curl -s http://localhost:8080/health; echo; done
```

Expected: the log output shows requests arriving at both replica containers. If
every request lands on one container, the `resolver` directive is not working —
check that `proxy_pass` uses the `$upstream` variable.

- [ ] **Step 5: Commit**

```bash
git add nginx docker-compose.yml
git commit -m "chore(infra): run two API replicas behind nginx"
```

---

## Task 8: The concurrency proof

**Files:**
- Create: `scripts/concurrency-test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run test:concurrency`, exiting 0 only when exactly one booking
  succeeded.

- [ ] **Step 1: Write the script**

```ts
// scripts/concurrency-test.ts
/**
 * Concurrency proof.
 *
 * Fires N simultaneous booking requests for the SAME slot at nginx, which
 * spreads them across multiple API replicas, and asserts that PostgreSQL
 * allowed exactly one.
 *
 * Each request uses a DIFFERENT patient. Using one patient would trip
 * appointments_patient_no_overlap instead of appointments_no_overlap, and the
 * test would pass for the wrong reason.
 */
import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

loadDotenv();

const BASE_URL = process.env.CONCURRENCY_BASE_URL ?? 'http://localhost:8080';
const CONCURRENT_REQUESTS = Number(process.env.CONCURRENCY_REQUESTS ?? 10);
const ADMIN_EMAIL = process.env.ADMIN_EMAIL!;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD!;

interface BookingOutcome {
  status: number;
  code?: string;
}

async function post(path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function login(email: string, password: string): Promise<string> {
  const response = await post('/auth/login', { email, password });
  if (!response.ok) {
    throw new Error(`Login failed for ${email}: ${response.status}`);
  }
  return ((await response.json()) as { accessToken: string }).accessToken;
}

async function registerPatient(index: number): Promise<string> {
  const email = `concurrency.patient.${index}.${Date.now()}@clinic.test`;
  const password = 'concurrency-test-password';

  const response = await post('/auth/register', {
    firstName: 'Concurrency',
    lastName: `Patient${index}`,
    email,
    password,
  });
  if (response.status !== 201) {
    throw new Error(`Register failed for ${email}: ${response.status}`);
  }

  return login(email, password);
}

async function main(): Promise<void> {
  const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

  // A dedicated doctor, so a rerun never collides with existing data.
  const doctorEmail = `concurrency.doctor.${Date.now()}@clinic.test`;
  const doctorResponse = await post(
    '/doctors',
    {
      firstName: 'Concurrency',
      lastName: 'Doctor',
      email: doctorEmail,
      password: 'concurrency-test-password',
      specialization: 'Testing',
    },
    adminToken,
  );
  const doctorId = ((await doctorResponse.json()) as { id: string }).id;
  const doctorToken = await login(doctorEmail, 'concurrency-test-password');

  // One slot, on a fixed weekday, well in the future.
  const target = new Date();
  target.setUTCDate(target.getUTCDate() + 14);
  target.setUTCHours(10, 0, 0, 0);
  const dayOfWeek = target.getUTCDay();

  await post(
    `/doctors/${doctorId}/schedules`,
    { dayOfWeek, startTime: '10:00:00', endTime: '11:00:00', slotDurationMinutes: 30 },
    doctorToken,
  );

  const tokens = await Promise.all(
    Array.from({ length: CONCURRENT_REQUESTS }, (_, index) => registerPatient(index)),
  );

  console.log(
    `Firing ${CONCURRENT_REQUESTS} concurrent bookings at ${BASE_URL} ` +
      `for ${target.toISOString()}`,
  );

  const outcomes: BookingOutcome[] = await Promise.all(
    tokens.map(async (token) => {
      const response = await post(
        '/appointments',
        { doctorId, startAt: target.toISOString() },
        token,
      );
      const body = (await response.json().catch(() => ({}))) as { code?: string };
      return { status: response.status, code: body.code };
    }),
  );

  const created = outcomes.filter((o) => o.status === 201).length;
  const conflicted = outcomes.filter(
    (o) => o.status === 409 && o.code === 'SLOT_ALREADY_BOOKED',
  ).length;
  const serverErrors = outcomes.filter((o) => o.status >= 500).length;
  const unexpected = outcomes.filter(
    (o) => o.status !== 201 && !(o.status === 409 && o.code === 'SLOT_ALREADY_BOOKED'),
  );

  const dataSource = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    synchronize: false,
  });
  await dataSource.initialize();

  const [{ count }] = (await dataSource.query(
    `SELECT count(*)::int AS count
       FROM appointments
      WHERE doctor_id = $1 AND start_at = $2 AND status = 'CONFIRMED'`,
    [doctorId, target.toISOString()],
  )) as Array<{ count: number }>;

  await dataSource.destroy();

  console.log('');
  console.log(`Successful bookings:            ${created}`);
  console.log(`Conflicted bookings (409):      ${conflicted}`);
  console.log(`Unexpected errors (5xx):        ${serverErrors}`);
  console.log(`Confirmed appointments in DB:   ${count}`);
  console.log('');

  const failures: string[] = [];
  if (created !== 1) failures.push(`expected exactly 1 success, got ${created}`);
  if (count !== 1) failures.push(`expected exactly 1 confirmed row, got ${count}`);
  if (serverErrors !== 0) failures.push(`expected 0 server errors, got ${serverErrors}`);
  if (conflicted !== CONCURRENT_REQUESTS - 1) {
    failures.push(
      `expected ${CONCURRENT_REQUESTS - 1} SLOT_ALREADY_BOOKED conflicts, got ${conflicted}`,
    );
  }

  if (failures.length > 0) {
    console.error('FAILED:');
    failures.forEach((failure) => console.error(`  - ${failure}`));
    if (unexpected.length > 0) {
      console.error(`  unexpected outcomes: ${JSON.stringify(unexpected)}`);
    }
    process.exit(1);
  }

  console.log('PASSED: exactly one booking succeeded.');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

Three assertions rather than one. Asserting only "one success" would pass even
if the other nine failed with 500s, which would mean the constraint fired but the
error mapping did not.

- [ ] **Step 2: Add the npm script**

```json
"test:concurrency": "ts-node -r tsconfig-paths/register scripts/concurrency-test.ts"
```

- [ ] **Step 3: Run the proof**

```bash
docker compose up --build -d
npm run seed:admin
npm run test:concurrency
```

Expected output:

```text
Successful bookings:            1
Conflicted bookings (409):      9
Unexpected errors (5xx):        0
Confirmed appointments in DB:   1

PASSED: exactly one booking succeeded.
```

- [ ] **Step 4: Prove the test can actually fail**

Temporarily comment out the `appointments_no_overlap` constraint in the migration,
recreate the database, and rerun:

```bash
docker compose down -v
docker compose up --build -d
npm run seed:admin
npm run test:concurrency
```

Expected: FAILS, reporting more than one success. Then restore the constraint and
confirm it passes again.

A concurrency test that has never been observed failing is not evidence of
anything. Do this once, and mention it in the recording.

- [ ] **Step 5: Commit**

```bash
git add scripts package.json
git commit -m "test(appointments): add concurrent booking proof against multiple replicas"
```

---

## Definition of Done

- [ ] The raw SQL checks in Task 1 Step 5 all behave as described.
- [ ] `npm test` and `npm run test:e2e` pass.
- [ ] `docker compose ps` shows two healthy `api` replicas behind `nginx`.
- [ ] `npm run test:concurrency` prints exactly one success, nine 409s, zero 5xx.
- [ ] Removing the exclusion constraint makes the concurrency test fail.
- [ ] `POST /appointments` with an `endAt` in the body returns 400.
- [ ] Booking a slot taken by another patient returns 409 `SLOT_ALREADY_BOOKED`
      with `waitingListAvailable: true`.
- [ ] Booking an overlapping slot with a second doctor as the same patient
      returns 409 `PATIENT_ALREADY_BOOKED`.
- [ ] Cancelling at exactly 2 hours ahead succeeds; 1h59m fails.
- [ ] Cancelling twice returns 200 both times with an unchanged `cancelledAt`.
- [ ] `npm run migration:revert` then `npm run migration:run` succeeds.

---

## Next

Plan 6 fills the two integration points marked `PLAN 6 INTEGRATION POINT` in
`appointments.service.ts`: the PENDING reminder row inside the booking
transaction, and the two post-commit calls on `JobsService` (`scheduleReminder`
after book, `removeReminder` + `enqueueSlotProcessing` after cancel). Do not
`@InjectQueue` in this service. Plan 7 consumes `createFromWaitingList` and the
constraint names exported here.
