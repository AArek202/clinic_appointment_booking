# Waiting List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Patients can queue for a taken slot, and when that slot is cancelled a
background job assigns it to the earliest eligible waiter — safely, idempotently,
and without ever double-booking.

**Architecture:** FIFO auto-assignment. Cancellation enqueues a job after commit;
the job re-derives everything from the database, locks candidates with
`FOR UPDATE SKIP LOCKED`, and walks them inside `SAVEPOINT`s so one ineligible
candidate cannot abort the whole transaction. The exclusion constraints from
Plan 5 remain the final authority.

**Tech Stack:** NestJS 11, TypeORM, PostgreSQL 16, BullMQ, Jest 30, Supertest.

## Global Constraints

- `synchronize: true` is forbidden everywhere.
- Names come from `docs/PLANS/00-interfaces.md`, which wins on any conflict.
- Enums stored as `text` with a `CHECK` constraint.
- `WAITING_LIST_CANDIDATE_LIMIT = 10` from `src/jobs/queue.constants.ts` (Plan 6).
- Jobs are enqueued **only after** the transaction commits, and payloads carry
  identifiers only, never state. (`docs/INFRASTRUCTURE/BackgroundJobs.md`)
- `AppointmentsModule` and `WaitingListModule` must never import each other. The
  processor in `ProcessorsModule` (worker process only) orchestrates both.
  `JobsModule` is queues and `JobsService` only — imported by the API too, so it
  must never register a processor. (`docs/ARCHITECTURE.md`, Plan 6)
- All time comes from the injected `Clock`.
- Commit messages follow `docs/DEVELOPMENT.md`.

## Assumptions being implemented

From `docs/FEATURES/WaitingList.md`, restated because the plan must match them:

1. FIFO by `created_at`. No priority tiers.
2. One active (`WAITING`) entry per patient per slot, enforced by a partial
   unique index.
3. A patient may queue for several different slots.
4. A patient cannot queue for a slot they already hold, or for a slot that is
   actually free.
5. Entries expire implicitly when `slot_start_at` passes, or at an optional
   patient-supplied `expires_at`.
6. Assignment is asynchronous and safe to retry.
7. Assigned appointments get `created_from = 'WAITING_LIST'` and their own
   reminder.
8. Notification is a `notifications` row plus a log line.

---

## File Structure

**Created:**

```text
src/common/enums/waiting-list-status.enum.ts

src/waiting-list/
  waiting-list-entry.entity.ts
  waiting-list.repository.ts
  waiting-list.service.ts
  waiting-list.controller.ts
  waiting-list.module.ts
  dto/join-waiting-list.dto.ts

src/jobs/waiting-list.processor.ts

src/database/migrations/1756800500000-CreateWaitingList.ts

test/waiting-list.e2e-spec.ts
test/waiting-list-assignment.e2e-spec.ts
```

**Modified:** `src/app.module.ts`, `src/jobs/processors.module.ts` (register
`WaitingListProcessor` and swap the `WaitingListReconciler` binding),
`src/appointments/appointments.service.ts` (filling Plan 5's cancel
integration point via `JobsService`).

**Do not modify** `src/jobs/jobs.module.ts` or
`src/jobs/reconciliation.processor.ts`. Plan 6 isolated waiting-list work behind
a port; this plan fills the port, it does not edit the sweeper.

---

## Task 1: The waiting_list table

**Files:**
- Create: `src/common/enums/waiting-list-status.enum.ts`
- Create: `src/waiting-list/waiting-list-entry.entity.ts`
- Create: `src/database/migrations/1756800500000-CreateWaitingList.ts`

**Interfaces:**
- Consumes: `doctors`, `patients` (Plan 2).
- Produces: `WaitingListStatus`, `WaitingListEntry`; table `waiting_list`;
  index `waiting_list_one_active` (partial unique) and
  `waiting_list_slot_status_idx`.

- [ ] **Step 1: Create the enum**

```ts
// src/common/enums/waiting-list-status.enum.ts
export enum WaitingListStatus {
  Waiting = 'WAITING',
  Assigned = 'ASSIGNED',
  Expired = 'EXPIRED',
  Cancelled = 'CANCELLED',
}
```

- [ ] **Step 2: Create the entity**

```ts
// src/waiting-list/waiting-list-entry.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { WaitingListStatus } from '../common/enums/waiting-list-status.enum';

@Entity('waiting_list')
export class WaitingListEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'doctor_id', type: 'uuid' })
  doctorId!: string;

  @Column({ name: 'patient_id', type: 'uuid' })
  patientId!: string;

  @Column({ name: 'slot_start_at', type: 'timestamptz' })
  slotStartAt!: Date;

  /**
   * Stored rather than re-derived, because the schedule's slot duration may
   * have changed since the patient joined the queue.
   */
  @Column({ name: 'slot_end_at', type: 'timestamptz' })
  slotEndAt!: Date;

  @Column({ type: 'text' })
  status!: WaitingListStatus;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
```

- [ ] **Step 3: Write the migration**

```ts
// src/database/migrations/1756800500000-CreateWaitingList.ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWaitingList1756800500000 implements MigrationInterface {
  name = 'CreateWaitingList1756800500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE waiting_list (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        doctor_id     uuid NOT NULL REFERENCES doctors (id) ON DELETE RESTRICT,
        patient_id    uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
        slot_start_at timestamptz NOT NULL,
        slot_end_at   timestamptz NOT NULL,
        status        text NOT NULL,
        expires_at    timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT waiting_list_time_valid CHECK (slot_end_at > slot_start_at),
        CONSTRAINT waiting_list_status_valid
          CHECK (status IN ('WAITING', 'ASSIGNED', 'EXPIRED', 'CANCELLED')),
        CONSTRAINT waiting_list_expiry_valid
          CHECK (expires_at IS NULL OR expires_at < slot_start_at)
      )
    `);

    // One active entry per patient per slot. Partial, so a patient whose
    // earlier entry expired or was cancelled can join again.
    // Enforced here rather than by a prior SELECT, which would race.
    await queryRunner.query(`
      CREATE UNIQUE INDEX waiting_list_one_active
        ON waiting_list (doctor_id, patient_id, slot_start_at)
        WHERE status = 'WAITING'
    `);

    // The assignment job finding candidates for a freed slot, and the
    // sweeper scanning for stranded entries.
    await queryRunner.query(`
      CREATE INDEX waiting_list_slot_status_idx
        ON waiting_list (doctor_id, slot_start_at, status)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE waiting_list`);
  }
}
```

`waiting_list_expiry_valid` encodes the rule that an expiry after the slot has
already started is meaningless.

- [ ] **Step 4: Run the migration and verify the partial index**

```bash
npm run migration:run
docker compose exec postgres psql -U clinic -d clinic -c "\d waiting_list"
```

Expected: `waiting_list_one_active` listed as a unique index with
`WHERE (status = 'WAITING'::text)`.

- [ ] **Step 5: Prove the partial unique index in raw SQL**

```sql
-- Two WAITING entries, same patient and slot: second must fail with 23505.
INSERT INTO waiting_list (doctor_id, patient_id, slot_start_at, slot_end_at, status)
VALUES ('<doctor>', '<patient>', '2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z', 'WAITING');

INSERT INTO waiting_list (doctor_id, patient_id, slot_start_at, slot_end_at, status)
VALUES ('<doctor>', '<patient>', '2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z', 'WAITING');

-- After expiring the first, a new WAITING entry must be allowed.
UPDATE waiting_list SET status = 'EXPIRED';
INSERT INTO waiting_list (doctor_id, patient_id, slot_start_at, slot_end_at, status)
VALUES ('<doctor>', '<patient>', '2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z', 'WAITING');
```

Expected: insert 1 succeeds, insert 2 fails on `waiting_list_one_active`, insert
3 succeeds. Clean up with `DELETE FROM waiting_list;`.

- [ ] **Step 6: Verify revert and re-run, then commit**

```bash
npm run migration:revert && npm run migration:run
git add src/common/enums/waiting-list-status.enum.ts src/waiting-list src/database/migrations
git commit -m "feat(waiting-list): add waiting_list table with single-active-entry index"
```

---

## Task 2: The waiting list repository

**Files:**
- Create: `src/waiting-list/waiting-list.repository.ts`

**Interfaces:**
- Produces: `WaitingListRepository` with `insertWaiting`, `findById`,
  `findCandidates`, `markAssigned`, `markStatus`, `countAhead`,
  `listForPatient`, `expireStale`, `findSlotsWithWaiters`.
  `findSlotsWithWaiters` is what fills Plan 6's sweeper deferral.

- [ ] **Step 1: Implement the repository**

```ts
// src/waiting-list/waiting-list.repository.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { WaitingListStatus } from '../common/enums/waiting-list-status.enum';
import { WaitingListEntry } from './waiting-list-entry.entity';

export interface InsertWaitingParams {
  doctorId: string;
  patientId: string;
  slotStartAt: Date;
  slotEndAt: Date;
  expiresAt: Date | null;
}

export interface SlotWithWaiters {
  doctorId: string;
  slotStartAt: Date;
}

@Injectable()
export class WaitingListRepository {
  constructor(
    @InjectRepository(WaitingListEntry)
    private readonly repo: Repository<WaitingListEntry>,
  ) {}

  /** Does not catch the unique violation: the caller maps it to a 409. */
  insertWaiting(params: InsertWaitingParams): Promise<WaitingListEntry> {
    return this.repo.save(
      this.repo.create({ ...params, status: WaitingListStatus.Waiting }),
    );
  }

  findById(id: string): Promise<WaitingListEntry | null> {
    return this.repo.findOne({ where: { id } });
  }

  /**
   * Eligible candidates for a freed slot, oldest first, row-locked.
   *
   * SKIP LOCKED means two workers processing the same slot never pick the
   * same patient: the second worker skips rows the first has locked instead
   * of blocking on them.
   */
  findCandidates(
    manager: EntityManager,
    doctorId: string,
    slotStartAt: Date,
    limit: number,
    now: Date,
  ): Promise<WaitingListEntry[]> {
    return manager
      .createQueryBuilder(WaitingListEntry, 'w')
      .where('w.doctor_id = :doctorId', { doctorId })
      .andWhere('w.slot_start_at = :slotStartAt', { slotStartAt })
      .andWhere('w.status = :status', { status: WaitingListStatus.Waiting })
      .andWhere('(w.expires_at IS NULL OR w.expires_at > :now)', { now })
      .andWhere('w.slot_start_at > :now', { now })
      .orderBy('w.created_at', 'ASC')
      .limit(limit)
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .getMany();
  }

  /**
   * Conditional WAITING -> ASSIGNED.
   * False means another worker already took this entry.
   */
  async markAssigned(manager: EntityManager, entryId: string): Promise<boolean> {
    const result = await manager
      .createQueryBuilder()
      .update(WaitingListEntry)
      .set({ status: WaitingListStatus.Assigned })
      .where('id = :entryId AND status = :status', {
        entryId,
        status: WaitingListStatus.Waiting,
      })
      .execute();

    return (result.affected ?? 0) > 0;
  }

  async markStatus(
    entryId: string,
    from: WaitingListStatus,
    to: WaitingListStatus,
  ): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(WaitingListEntry)
      .set({ status: to })
      .where('id = :entryId AND status = :from', { entryId, from })
      .execute();

    return (result.affected ?? 0) > 0;
  }

  /** Queue position: how many active entries were created before this one. */
  async countAhead(entry: WaitingListEntry): Promise<number> {
    return this.repo.count({
      where: {
        doctorId: entry.doctorId,
        slotStartAt: entry.slotStartAt,
        status: WaitingListStatus.Waiting,
        createdAt: LessThan(entry.createdAt),
      },
    });
  }

  listForPatient(patientId: string): Promise<WaitingListEntry[]> {
    return this.repo.find({
      where: { patientId, status: WaitingListStatus.Waiting },
      order: { slotStartAt: 'ASC' },
    });
  }

  /** Sweeper: expire entries whose deadline or slot time has passed. */
  async expireStale(now: Date): Promise<number> {
    const result = await this.repo.query(
      `UPDATE waiting_list
          SET status = 'EXPIRED', updated_at = now()
        WHERE status = 'WAITING'
          AND (slot_start_at <= $1 OR (expires_at IS NOT NULL AND expires_at <= $1))`,
      [now],
    );

    // node-postgres returns the row count as the second element for UPDATE.
    return Array.isArray(result) ? (result[1] as number) : 0;
  }

  /**
   * Sweeper: slots that are free (no CONFIRMED appointment) but still have
   * waiters. These are the assignments a lost enqueue would have dropped.
   */
  findSlotsWithWaiters(limit: number): Promise<SlotWithWaiters[]> {
    return this.repo.query(
      `SELECT DISTINCT w.doctor_id AS "doctorId", w.slot_start_at AS "slotStartAt"
         FROM waiting_list w
        WHERE w.status = 'WAITING'
          AND w.slot_start_at > now()
          AND NOT EXISTS (
                SELECT 1 FROM appointments a
                 WHERE a.doctor_id = w.doctor_id
                   AND a.status = 'CONFIRMED'
                   AND tstzrange(a.start_at, a.end_at, '[)')
                       && tstzrange(w.slot_start_at, w.slot_end_at, '[)')
              )
        LIMIT $1`,
      [limit],
    );
  }
}
```

Add `import { LessThan } from 'typeorm';`.

`findSlotsWithWaiters` uses the same `&&` range test and `'[)'` bound as the
exclusion constraint, so "is this slot free?" means exactly the same thing to
the sweeper as it does to the database.

- [ ] **Step 2: Commit**

```bash
git add src/waiting-list/waiting-list.repository.ts
git commit -m "feat(waiting-list): add waiting list repository with SKIP LOCKED candidates"
```

---

## Task 3: Joining and leaving the queue

**Files:**
- Create: `src/waiting-list/dto/join-waiting-list.dto.ts`
- Create: `src/waiting-list/waiting-list.service.ts`
- Create: `src/waiting-list/waiting-list.controller.ts`
- Create: `src/waiting-list/waiting-list.module.ts`
- Test: `test/waiting-list.e2e-spec.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `resolveSlot` (Plan 4), `SchedulesRepository` (Plan 3),
  `AppointmentsRepository` (Plan 5), `Clock`.
- Produces: `POST /waiting-list`, `GET /waiting-list/me`,
  `DELETE /waiting-list/:id`; `WaitingListService.join/leave/listForPatient`.

Note: `WaitingListModule` imports `AppointmentsModule` to read appointment state
when validating a join. That direction is fine. The reverse — `AppointmentsModule`
importing `WaitingListModule` — is forbidden.

- [ ] **Step 1: Write the DTO**

```ts
// src/waiting-list/dto/join-waiting-list.dto.ts
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsUUID } from 'class-validator';

export class JoinWaitingListDto {
  @IsUUID()
  doctorId!: string;

  @Type(() => Date)
  @IsDate()
  slotStartAt!: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expiresAt?: Date;
}
```

- [ ] **Step 2: Write the failing e2e tests**

```ts
// test/waiting-list.e2e-spec.ts
it('lets a patient join the queue for a taken slot', async () => {
  await bookAs(patientAToken, doctorId, '2026-10-05T07:00:00.000Z');

  const response = await request(app.getHttpServer())
    .post('/waiting-list')
    .set('Authorization', `Bearer ${patientBToken}`)
    .send({ doctorId, slotStartAt: '2026-10-05T07:00:00.000Z' })
    .expect(201);

  expect(response.body).toEqual({
    id: expect.any(String),
    doctorId,
    slotStartAt: '2026-10-05T07:00:00.000Z',
    slotEndAt: '2026-10-05T07:30:00.000Z',
    status: 'WAITING',
    position: 1,
  });
});

it('reports increasing positions in join order', async () => {
  await bookAs(patientAToken, doctorId, '2026-10-05T07:00:00.000Z');

  const first = await joinAs(patientBToken, doctorId, '2026-10-05T07:00:00.000Z');
  const second = await joinAs(patientCToken, doctorId, '2026-10-05T07:00:00.000Z');

  expect(first.position).toBe(1);
  expect(second.position).toBe(2);
});

it('refuses to queue for a slot that is actually free', async () => {
  const response = await request(app.getHttpServer())
    .post('/waiting-list')
    .set('Authorization', `Bearer ${patientBToken}`)
    .send({ doctorId, slotStartAt: '2026-10-05T07:00:00.000Z' })
    .expect(409);

  expect(response.body.code).toBe('SLOT_IS_AVAILABLE');
});

it('refuses a duplicate active entry', async () => {
  await bookAs(patientAToken, doctorId, '2026-10-05T07:00:00.000Z');
  await joinAs(patientBToken, doctorId, '2026-10-05T07:00:00.000Z');

  const response = await request(app.getHttpServer())
    .post('/waiting-list')
    .set('Authorization', `Bearer ${patientBToken}`)
    .send({ doctorId, slotStartAt: '2026-10-05T07:00:00.000Z' })
    .expect(409);

  expect(response.body.code).toBe('ALREADY_IN_WAITING_LIST');
});

it('refuses to queue for a slot the patient already holds', async () => {
  await bookAs(patientBToken, doctorId, '2026-10-05T07:00:00.000Z');

  const response = await request(app.getHttpServer())
    .post('/waiting-list')
    .set('Authorization', `Bearer ${patientBToken}`)
    .send({ doctorId, slotStartAt: '2026-10-05T07:00:00.000Z' })
    .expect(409);

  expect(response.body.code).toBe('PATIENT_ALREADY_BOOKED');
});

it('rejects a slot that is not on the grid', async () => {
  const response = await request(app.getHttpServer())
    .post('/waiting-list')
    .set('Authorization', `Bearer ${patientBToken}`)
    .send({ doctorId, slotStartAt: '2026-10-05T07:07:00.000Z' })
    .expect(400);

  expect(response.body.code).toBe('SLOT_NOT_ON_GRID');
});

it('rejects an expiresAt after the slot start', async () => {
  await bookAs(patientAToken, doctorId, '2026-10-05T07:00:00.000Z');

  await request(app.getHttpServer())
    .post('/waiting-list')
    .set('Authorization', `Bearer ${patientBToken}`)
    .send({
      doctorId,
      slotStartAt: '2026-10-05T07:00:00.000Z',
      expiresAt: '2026-10-05T08:00:00.000Z',
    })
    .expect(400);
});

it('lets a patient leave the queue and rejoin afterwards', async () => {
  await bookAs(patientAToken, doctorId, '2026-10-05T07:00:00.000Z');
  const entry = await joinAs(patientBToken, doctorId, '2026-10-05T07:00:00.000Z');

  await request(app.getHttpServer())
    .delete(`/waiting-list/${entry.id}`)
    .set('Authorization', `Bearer ${patientBToken}`)
    .expect(204);

  // The partial unique index only covers WAITING, so rejoining must work.
  await joinAs(patientBToken, doctorId, '2026-10-05T07:00:00.000Z');
});

it("refuses to remove another patient's entry", async () => {
  await bookAs(patientAToken, doctorId, '2026-10-05T07:00:00.000Z');
  const entry = await joinAs(patientBToken, doctorId, '2026-10-05T07:00:00.000Z');

  await request(app.getHttpServer())
    .delete(`/waiting-list/${entry.id}`)
    .set('Authorization', `Bearer ${patientCToken}`)
    .expect(403);
});
```

The rejoin-after-leaving test is what proves the unique index is partial rather
than absolute.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test:e2e -- waiting-list`
Expected: FAIL — `Cannot POST /waiting-list` (404).

- [ ] **Step 4: Implement the service**

```ts
// src/waiting-list/waiting-list.service.ts
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolveSlot } from '../availability/slot-generator';
import { AppointmentsRepository } from '../appointments/appointments.repository';
import { Clock } from '../common/clock/clock';
import { WaitingListStatus } from '../common/enums/waiting-list-status.enum';
import { AppException, BadRequestError, ConflictError } from '../common/errors/app.exception';
import { isConstraintViolation } from '../common/errors/database-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { SchedulesRepository } from '../schedules/schedules.repository';
import { JoinWaitingListDto } from './dto/join-waiting-list.dto';
import { WaitingListEntry } from './waiting-list-entry.entity';
import { WaitingListRepository } from './waiting-list.repository';

const ONE_ACTIVE = 'waiting_list_one_active';

export interface WaitingListEntryView {
  entry: WaitingListEntry;
  position: number;
}

@Injectable()
export class WaitingListService {
  constructor(
    private readonly entries: WaitingListRepository,
    private readonly schedules: SchedulesRepository,
    private readonly appointments: AppointmentsRepository,
    private readonly clock: Clock,
    private readonly config: ConfigService,
  ) {}

  async join(patientId: string, dto: JoinWaitingListDto): Promise<WaitingListEntryView> {
    const timeZone = this.config.getOrThrow<string>('CLINIC_TZ');

    if (dto.slotStartAt.getTime() <= this.clock.now().getTime()) {
      throw new BadRequestError(
        ErrorCode.SlotNotOnGrid,
        'You cannot join the waiting list for a slot in the past.',
      );
    }

    const windows = await this.schedules.findByDoctorId(dto.doctorId);
    const slot = resolveSlot(dto.slotStartAt, windows, timeZone);
    if (!slot) {
      throw new BadRequestError(
        ErrorCode.SlotNotOnGrid,
        "The requested time is not one of this doctor's slots.",
      );
    }

    if (dto.expiresAt && dto.expiresAt.getTime() >= slot.startAt.getTime()) {
      throw new BadRequestError(
        ErrorCode.ValidationFailed,
        'expiresAt must be before the slot start time.',
      );
    }

    // Queueing only makes sense for a slot that is actually taken.
    const [booked] = await this.appointments.findBookedRanges(
      dto.doctorId,
      slot.startAt,
      slot.endAt,
    );
    if (!booked) {
      throw new ConflictError(
        ErrorCode.SlotIsAvailable,
        'This slot is currently available — book it instead of queueing.',
      );
    }

    const ownConflict = await this.appointments.findOverlappingForPatient(
      patientId,
      slot.startAt,
      slot.endAt,
    );
    if (ownConflict) {
      throw new ConflictError(
        ErrorCode.PatientAlreadyBooked,
        'You already have an appointment at this time.',
      );
    }

    try {
      const entry = await this.entries.insertWaiting({
        doctorId: dto.doctorId,
        patientId,
        slotStartAt: slot.startAt,
        slotEndAt: slot.endAt,
        expiresAt: dto.expiresAt ?? null,
      });

      return { entry, position: (await this.entries.countAhead(entry)) + 1 };
    } catch (error) {
      // The index, not a prior SELECT, is what makes this safe under
      // concurrent requests from the same patient.
      if (isConstraintViolation(error, ONE_ACTIVE)) {
        throw new ConflictError(
          ErrorCode.AlreadyInWaitingList,
          'You are already on the waiting list for this slot.',
        );
      }
      throw error;
    }
  }

  async leave(entryId: string, patientId: string): Promise<void> {
    const entry = await this.entries.findById(entryId);
    if (!entry) {
      throw new NotFoundException('Waiting list entry not found');
    }

    if (entry.patientId !== patientId) {
      throw new AppException(
        ErrorCode.Forbidden,
        'You can only leave your own waiting list entries.',
        HttpStatus.FORBIDDEN,
      );
    }

    // Conditional, so a repeated request is a no-op rather than an error.
    await this.entries.markStatus(
      entryId,
      WaitingListStatus.Waiting,
      WaitingListStatus.Cancelled,
    );
  }

  async listForPatient(patientId: string): Promise<WaitingListEntryView[]> {
    const entries = await this.entries.listForPatient(patientId);
    return Promise.all(
      entries.map(async (entry) => ({
        entry,
        position: (await this.entries.countAhead(entry)) + 1,
      })),
    );
  }
}
```

- [ ] **Step 5: Implement the controller and module**

```ts
// src/waiting-list/waiting-list.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { AuthUser } from '../auth/auth-user.interface';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums/role.enum';
import { JoinWaitingListDto } from './dto/join-waiting-list.dto';
import { WaitingListEntryView, WaitingListService } from './waiting-list.service';

function present(view: WaitingListEntryView) {
  return {
    id: view.entry.id,
    doctorId: view.entry.doctorId,
    slotStartAt: view.entry.slotStartAt.toISOString(),
    slotEndAt: view.entry.slotEndAt.toISOString(),
    status: view.entry.status,
    position: view.position,
  };
}

@Roles(UserRole.Patient)
@Controller('waiting-list')
export class WaitingListController {
  constructor(private readonly waitingList: WaitingListService) {}

  @Post()
  async join(@CurrentUser() user: AuthUser, @Body() dto: JoinWaitingListDto) {
    return present(await this.waitingList.join(user.patientId!, dto));
  }

  @Get('me')
  async mine(@CurrentUser() user: AuthUser) {
    const views = await this.waitingList.listForPatient(user.patientId!);
    return views.map(present);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async leave(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.waitingList.leave(id, user.patientId!);
  }
}
```

```ts
// src/waiting-list/waiting-list.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppointmentsModule } from '../appointments/appointments.module';
import { SchedulesModule } from '../schedules/schedules.module';
import { WaitingListEntry } from './waiting-list-entry.entity';
import { WaitingListController } from './waiting-list.controller';
import { WaitingListRepository } from './waiting-list.repository';
import { WaitingListService } from './waiting-list.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([WaitingListEntry]),
    SchedulesModule,
    // One-directional only. AppointmentsModule must never import this module.
    AppointmentsModule,
  ],
  controllers: [WaitingListController],
  providers: [WaitingListRepository, WaitingListService],
  exports: [WaitingListRepository, WaitingListService],
})
export class WaitingListModule {}
```

Add `WaitingListModule` to `src/app.module.ts`.

- [ ] **Step 6: Run the tests and commit**

```bash
npm run test:e2e -- waiting-list
git add src/waiting-list src/app.module.ts test/waiting-list.e2e-spec.ts
git commit -m "feat(waiting-list): add join, leave and list endpoints"
```

---

## Task 4: The assignment processor

The heart of this plan. Read `docs/FEATURES/WaitingList.md` "Handling a rejected
insert" before starting.

**Files:**
- Create: `src/jobs/waiting-list.processor.ts`
- Modify: `src/jobs/processors.module.ts`
- Test: `test/waiting-list-assignment.e2e-spec.ts`

**Interfaces:**
- Consumes: `QUEUE_WAITING_LIST`, `JOB_PROCESS_SLOT`, `ProcessSlotJobData`,
  `WAITING_LIST_CANDIDATE_LIMIT` (Plan 6);
  `AppointmentsService.createFromWaitingList` (Plan 5);
  `WaitingListRepository` (Task 2); `NotificationsRepository` (Plan 6).
- Produces: `WaitingListProcessor`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/waiting-list-assignment.e2e-spec.ts
// These tests invoke the processor directly with a synthetic job, so they
// test the logic without waiting on BullMQ timing.

it('assigns a freed slot to the first waiter', async () => {
  const appointment = await bookAs(patientAToken, doctorId, '2026-10-05T09:00:00.000Z');
  await joinAs(patientBToken, doctorId, '2026-10-05T09:00:00.000Z');
  await cancelAs(patientAToken, appointment.id);

  await processor.process(jobFor(doctorId, '2026-10-05T09:00:00.000Z'));

  const [row] = await dataSource.query(
    `SELECT patient_id, created_from FROM appointments
      WHERE status = 'CONFIRMED' AND start_at = $1`,
    ['2026-10-05T09:00:00.000Z'],
  );
  expect(row.patient_id).toBe(patientBId);
  expect(row.created_from).toBe('WAITING_LIST');

  const [entry] = await dataSource.query(`SELECT status FROM waiting_list`);
  expect(entry.status).toBe('ASSIGNED');
});

it('assigns in FIFO order, not to the last joiner', async () => {
  const appointment = await bookAs(patientAToken, doctorId, '2026-10-05T09:00:00.000Z');
  await joinAs(patientBToken, doctorId, '2026-10-05T09:00:00.000Z');
  await joinAs(patientCToken, doctorId, '2026-10-05T09:00:00.000Z');
  await cancelAs(patientAToken, appointment.id);

  await processor.process(jobFor(doctorId, '2026-10-05T09:00:00.000Z'));

  const [row] = await dataSource.query(
    `SELECT patient_id FROM appointments WHERE status = 'CONFIRMED' AND start_at = $1`,
    ['2026-10-05T09:00:00.000Z'],
  );
  expect(row.patient_id).toBe(patientBId);
});

it('skips a candidate who is busy elsewhere and assigns the next one', async () => {
  // Patient B queues for doctor 1's 09:00 slot, then books doctor 2 at 09:00.
  const appointment = await bookAs(patientAToken, doctorId, '2026-10-05T09:00:00.000Z');
  await joinAs(patientBToken, doctorId, '2026-10-05T09:00:00.000Z');
  await joinAs(patientCToken, doctorId, '2026-10-05T09:00:00.000Z');
  await bookAs(patientBToken, secondDoctorId, '2026-10-05T09:00:00.000Z');
  await cancelAs(patientAToken, appointment.id);

  await processor.process(jobFor(doctorId, '2026-10-05T09:00:00.000Z'));

  const [row] = await dataSource.query(
    `SELECT patient_id FROM appointments
      WHERE doctor_id = $1 AND status = 'CONFIRMED' AND start_at = $2`,
    [doctorId, '2026-10-05T09:00:00.000Z'],
  );
  expect(row.patient_id).toBe(patientCId);

  // B stays WAITING: being busy now says nothing about a future opening.
  const rows = await dataSource.query(
    `SELECT patient_id, status FROM waiting_list ORDER BY created_at`,
  );
  expect(rows[0]).toMatchObject({ patient_id: patientBId, status: 'WAITING' });
  expect(rows[1]).toMatchObject({ patient_id: patientCId, status: 'ASSIGNED' });
});

it('does nothing when a direct booking already took the freed slot', async () => {
  const appointment = await bookAs(patientAToken, doctorId, '2026-10-05T09:00:00.000Z');
  await joinAs(patientBToken, doctorId, '2026-10-05T09:00:00.000Z');
  await cancelAs(patientAToken, appointment.id);
  await bookAs(patientDToken, doctorId, '2026-10-05T09:00:00.000Z');

  await expect(
    processor.process(jobFor(doctorId, '2026-10-05T09:00:00.000Z')),
  ).resolves.not.toThrow();

  const [row] = await dataSource.query(
    `SELECT patient_id FROM appointments WHERE status = 'CONFIRMED' AND start_at = $1`,
    ['2026-10-05T09:00:00.000Z'],
  );
  expect(row.patient_id).toBe(patientDId);

  const [entry] = await dataSource.query(`SELECT status FROM waiting_list`);
  expect(entry.status).toBe('WAITING');
});

it('is idempotent: running twice assigns the slot only once', async () => {
  const appointment = await bookAs(patientAToken, doctorId, '2026-10-05T09:00:00.000Z');
  await joinAs(patientBToken, doctorId, '2026-10-05T09:00:00.000Z');
  await joinAs(patientCToken, doctorId, '2026-10-05T09:00:00.000Z');
  await cancelAs(patientAToken, appointment.id);

  await processor.process(jobFor(doctorId, '2026-10-05T09:00:00.000Z'));
  await processor.process(jobFor(doctorId, '2026-10-05T09:00:00.000Z'));

  const [{ count }] = await dataSource.query(
    `SELECT count(*)::int AS count FROM appointments
      WHERE status = 'CONFIRMED' AND start_at = $1`,
    ['2026-10-05T09:00:00.000Z'],
  );
  expect(count).toBe(1);

  // C must not have been assigned by the second run.
  const [{ assigned }] = await dataSource.query(
    `SELECT count(*)::int AS assigned FROM waiting_list WHERE status = 'ASSIGNED'`,
  );
  expect(assigned).toBe(1);
});

it('skips an expired entry', async () => {
  const appointment = await bookAs(patientAToken, doctorId, '2026-10-05T09:00:00.000Z');
  await joinAs(patientBToken, doctorId, '2026-10-05T09:00:00.000Z', {
    expiresAt: '2026-10-05T05:00:00.000Z', // clock is fixed at 06:00Z
  });
  await joinAs(patientCToken, doctorId, '2026-10-05T09:00:00.000Z');
  await cancelAs(patientAToken, appointment.id);

  await processor.process(jobFor(doctorId, '2026-10-05T09:00:00.000Z'));

  const [row] = await dataSource.query(
    `SELECT patient_id FROM appointments WHERE status = 'CONFIRMED' AND start_at = $1`,
    ['2026-10-05T09:00:00.000Z'],
  );
  expect(row.patient_id).toBe(patientCId);
});

it('creates a reminder notification for the assigned appointment', async () => {
  const appointment = await bookAs(patientAToken, doctorId, '2026-10-05T09:00:00.000Z');
  await joinAs(patientBToken, doctorId, '2026-10-05T09:00:00.000Z');
  await cancelAs(patientAToken, appointment.id);

  await processor.process(jobFor(doctorId, '2026-10-05T09:00:00.000Z'));

  const rows = await dataSource.query(
    `SELECT type, status FROM notifications ORDER BY type`,
  );
  expect(rows).toEqual([
    { type: 'REMINDER', status: 'PENDING' },
    { type: 'WAITLIST_ASSIGNED', status: 'PENDING' },
  ]);
});

it('does nothing and does not throw when the queue is empty', async () => {
  const appointment = await bookAs(patientAToken, doctorId, '2026-10-05T09:00:00.000Z');
  await cancelAs(patientAToken, appointment.id);

  await expect(
    processor.process(jobFor(doctorId, '2026-10-05T09:00:00.000Z')),
  ).resolves.not.toThrow();
});
```

The "skips a candidate who is busy elsewhere" test is the one that exercises the
savepoint path, and it is the reason this processor is a loop rather than a single
insert.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:e2e -- waiting-list-assignment`
Expected: FAIL — processor does not exist.

- [ ] **Step 3: Implement the processor**

```ts
// src/jobs/waiting-list.processor.ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DataSource, EntityManager } from 'typeorm';
import { AppointmentsService } from '../appointments/appointments.service';
import { Clock } from '../common/clock/clock';
import { NotificationType } from '../common/enums/notification-type.enum';
import { REMINDER_LEAD_HOURS } from '../common/constants';
import { isConstraintViolation } from '../common/errors/database-error';
import { NotificationsRepository } from '../notifications/notifications.repository';
import { WaitingListRepository } from '../waiting-list/waiting-list.repository';
import {
  JOB_PROCESS_SLOT,
  ProcessSlotJobData,
  QUEUE_WAITING_LIST,
  WAITING_LIST_CANDIDATE_LIMIT,
} from './queue.constants';

const DOCTOR_OVERLAP = 'appointments_no_overlap';
const PATIENT_OVERLAP = 'appointments_patient_no_overlap';

@Processor(QUEUE_WAITING_LIST)
export class WaitingListProcessor extends WorkerHost {
  private readonly logger = new Logger(WaitingListProcessor.name);

  constructor(
    private readonly entries: WaitingListRepository,
    private readonly appointments: AppointmentsService,
    private readonly notifications: NotificationsRepository,
    private readonly clock: Clock,
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  async process(job: Job<ProcessSlotJobData>): Promise<void> {
    if (job.name !== JOB_PROCESS_SLOT) {
      return;
    }

    const { doctorId, slotStartAtIso } = job.data;
    const slotStartAt = new Date(slotStartAtIso);

    // Everything is re-derived from the database. The payload carries only
    // identifiers, so a retry always acts on current state.
    await this.dataSource.transaction(async (manager) => {
      const assigned = await this.assign(manager, doctorId, slotStartAt);

      if (!assigned) {
        this.logger.log(
          `No assignment for doctor ${doctorId} at ${slotStartAtIso}: ` +
            'slot taken, queue empty, or no eligible candidate.',
        );
      }
    });
  }

  private async assign(
    manager: EntityManager,
    doctorId: string,
    slotStartAt: Date,
  ): Promise<boolean> {
    const now = this.clock.now();

    const candidates = await this.entries.findCandidates(
      manager,
      doctorId,
      slotStartAt,
      WAITING_LIST_CANDIDATE_LIMIT,
      now,
    );

    for (const candidate of candidates) {
      // An error aborts a PostgreSQL transaction, so each attempt gets its
      // own savepoint. Without this, the first ineligible candidate would
      // destroy the whole transaction and no one would get the slot.
      await manager.query('SAVEPOINT candidate_attempt');

      try {
        const appointment = await this.appointments.createFromWaitingList(manager, {
          doctorId,
          patientId: candidate.patientId,
          startAt: candidate.slotStartAt,
          endAt: candidate.slotEndAt,
        });

        const claimed = await this.entries.markAssigned(manager, candidate.id);
        if (!claimed) {
          // Another worker took this entry between our lock and our update.
          await manager.query('ROLLBACK TO SAVEPOINT candidate_attempt');
          continue;
        }

        const reminderAt = new Date(
          appointment.startAt.getTime() - REMINDER_LEAD_HOURS * 60 * 60 * 1000,
        );

        await this.notifications.createPending(manager, {
          appointmentId: appointment.id,
          patientId: candidate.patientId,
          type: NotificationType.Reminder,
          scheduledAt: reminderAt,
        });

        await this.notifications.createPending(manager, {
          appointmentId: appointment.id,
          patientId: candidate.patientId,
          type: NotificationType.WaitlistAssigned,
          scheduledAt: now,
        });

        await manager.query('RELEASE SAVEPOINT candidate_attempt');

        this.logger.log(
          `Assigned slot ${slotStartAt.toISOString()} for doctor ${doctorId} ` +
            `to patient ${candidate.patientId} (appointment ${appointment.id}).`,
        );
        return true;
      } catch (error) {
        await manager.query('ROLLBACK TO SAVEPOINT candidate_attempt');

        // The doctor's slot is gone -- a direct booking won the race. No
        // retry can help, and the queue stays intact for a future opening.
        if (isConstraintViolation(error, DOCTOR_OVERLAP)) {
          this.logger.log(
            `Slot ${slotStartAt.toISOString()} for doctor ${doctorId} was taken ` +
              'by a direct booking. Nothing to assign.',
          );
          return false;
        }

        // This candidate is busy elsewhere, but the slot is still free.
        // Leave them WAITING and try the next one.
        if (isConstraintViolation(error, PATIENT_OVERLAP)) {
          this.logger.log(
            `Patient ${candidate.patientId} is unavailable at ` +
              `${slotStartAt.toISOString()}. Trying the next candidate.`,
          );
          continue;
        }

        throw error;
      }
    }

    return false;
  }
}
```

Register `WaitingListProcessor` in **`ProcessorsModule`**, not `JobsModule`.
`JobsModule` is imported by the API; putting a `@Processor` there would start a
worker inside every replica and silently double job concurrency when the API
scales — the exact coupling Plan 6 exists to prevent.

Add `WaitingListModule` to `ProcessorsModule`'s imports, and add
`WaitingListProcessor` to its providers. `src/app.module.ts` must still not
import `ProcessorsModule`.

Two details worth being able to defend. First, `markAssigned` is conditional and
its result is checked — if another worker claimed the entry between our locked
read and our update, we roll back and move on rather than assigning the same
person twice. Second, the loop `continue`s on the patient constraint but
`return`s on the doctor constraint, because those two identical SQLSTATEs mean
opposite things about whether more work is possible.

- [ ] **Step 4: Run the tests and commit**

```bash
npm run test:e2e -- waiting-list-assignment
git add src/jobs test/waiting-list-assignment.e2e-spec.ts
git commit -m "feat(waiting-list): assign freed slots via background job with savepoint candidate loop"
```

---

## Task 5: Connect cancellation to the queue

**Files:**
- Modify: `src/appointments/appointments.service.ts`
- Modify: `src/appointments/appointments.module.ts`
- Test: `test/waiting-list-assignment.e2e-spec.ts`

**Interfaces:**
- Fills the `PLAN 6 INTEGRATION POINT` in `cancel()` that enqueues
  `WAITING_LIST_PROCESS`.

- [ ] **Step 1: Write the failing test**

```ts
it('enqueues waiting-list processing after a cancellation commits', async () => {
  const appointment = await bookAs(patientAToken, doctorId, '2026-10-05T09:00:00.000Z');
  await joinAs(patientBToken, doctorId, '2026-10-05T09:00:00.000Z');

  await cancelAs(patientAToken, appointment.id);

  const jobs = await waitingListQueue.getJobs(['waiting', 'delayed', 'active', 'completed']);
  expect(jobs).toHaveLength(1);
  expect(jobs[0].data).toEqual({
    doctorId,
    slotStartAtIso: '2026-10-05T09:00:00.000Z',
  });
});

it('collapses duplicate enqueues for the same slot into one job', async () => {
  const first = await bookAs(patientAToken, doctorId, '2026-10-05T09:00:00.000Z');
  await cancelAs(patientAToken, first.id);

  const second = await bookAs(patientDToken, doctorId, '2026-10-05T09:00:00.000Z');
  await cancelAs(patientDToken, second.id);

  const jobs = await waitingListQueue.getJobs(['waiting', 'delayed', 'active', 'completed']);
  expect(jobs).toHaveLength(1);
});
```

The second test proves the deterministic job id is doing its job.

- [ ] **Step 2: Implement the enqueue through `JobsService`**

Plan 6 made `JobsService` the only place that enqueues. Do not inject queues
into `AppointmentsService` — that would duplicate job-id and delay logic, and
quietly skip `sweepReminderJobId` later.

In `AppointmentsService`, inject `JobsService` and replace the Plan 5
integration comment in `cancel()`:

```ts
  constructor(
    // ...existing dependencies...
    private readonly jobs: JobsService,
  ) {}
```

```ts
    // After the cancellation has committed. Never inside the transaction:
    // a worker could otherwise start before the commit lands, read a still
    // CONFIRMED appointment, correctly do nothing, and the slot would never
    // be reassigned.
    await this.jobs.removeReminder(appointment.id);
    await this.jobs.enqueueSlotProcessing(appointment.doctorId, appointment.startAt);
```

Add `JobsModule` to `AppointmentsModule` imports. `AppointmentsModule` still
does not import `WaitingListModule` — it only asks `JobsService` to put a
message on a queue. That is what keeps the dependency one-directional.

- [ ] **Step 3: Run the tests and commit**

```bash
npm run test:e2e -- waiting-list-assignment
git add src/appointments
git commit -m "feat(appointments): enqueue waiting-list processing after cancellation commits"
```

---

## Task 6: Bind the sweeper's waiting-list port

Plan 6 isolated the two sweeper passes that need `waiting_list` behind
`WaitingListReconciler`, bound to `NoWaitingListReconciler` (`[]` and `0`).
This task replaces that one provider line. It does **not** edit
`reconciliation.processor.ts`.

**Files:**
- Create: `src/waiting-list/waiting-list-reconciler.adapter.ts`
- Modify: `src/jobs/processors.module.ts`
- Test: `test/reconciliation.e2e-spec.ts` (extend Plan 6's file)

**Interfaces:**
- Consumes: `WaitingListReconciler` and `StrandedSlot` from
  `src/jobs/waiting-list-reconciler.ts` (Plan 6); `WaitingListRepository.expireStale`
  and `findSlotsWithWaiters` (Task 2); `JobsService.enqueueSlotProcessing`.
- Produces: `WaitingListReconcilerAdapter` bound in `ProcessorsModule`.

- [ ] **Step 1: Write the failing tests**

Add to `test/reconciliation.e2e-spec.ts`. The test module must bind
`WaitingListReconciler` to the real adapter, not the no-op — otherwise these
pass without proving anything.

```ts
it('recovers an assignment whose enqueue was lost', async () => {
  const appointment = await bookAs(patientAToken, doctorId, '2026-10-05T09:00:00.000Z');
  await joinAs(patientBToken, doctorId, '2026-10-05T09:00:00.000Z');

  // Simulate the crash window: cancel in the database directly, so no job is
  // ever enqueued.
  await dataSource.query(
    `UPDATE appointments SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1`,
    [appointment.id],
  );

  await reconciliation.process(reconcileJob());

  const jobs = await waitingListQueue.getJobs(['waiting', 'delayed', 'active', 'completed']);
  expect(jobs).toHaveLength(1);
  expect(jobs[0].data).toEqual({
    doctorId,
    slotStartAtIso: '2026-10-05T09:00:00.000Z',
  });
});

it('does not re-enqueue a slot that already has a confirmed booking', async () => {
  const appointment = await bookAs(patientAToken, doctorId, '2026-10-05T09:00:00.000Z');
  await joinAs(patientBToken, doctorId, '2026-10-05T09:00:00.000Z');
  await cancelAs(patientAToken, appointment.id);
  await bookAs(patientDToken, doctorId, '2026-10-05T09:00:00.000Z');

  // Drain any job the cancel path already enqueued, then sweep.
  await waitingListQueue.obliterate({ force: true });
  await reconciliation.process(reconcileJob());

  const jobs = await waitingListQueue.getJobs(['waiting', 'delayed', 'active', 'completed']);
  expect(jobs).toHaveLength(0);
});

it('expires entries whose deadline has passed', async () => {
  await bookAs(patientAToken, doctorId, '2026-10-05T09:00:00.000Z');
  await joinAs(patientBToken, doctorId, '2026-10-05T09:00:00.000Z', {
    expiresAt: '2026-10-05T05:00:00.000Z', // clock fixed at 06:00Z
  });

  await reconciliation.process(reconcileJob());

  const [entry] = await dataSource.query(`SELECT status FROM waiting_list`);
  expect(entry.status).toBe('EXPIRED');
});

it('is safe to run twice', async () => {
  const appointment = await bookAs(patientAToken, doctorId, '2026-10-05T09:00:00.000Z');
  await joinAs(patientBToken, doctorId, '2026-10-05T09:00:00.000Z');
  await dataSource.query(
    `UPDATE appointments SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1`,
    [appointment.id],
  );

  await reconciliation.process(reconcileJob());
  await reconciliation.process(reconcileJob());

  const jobs = await waitingListQueue.getJobs(['waiting', 'delayed', 'active', 'completed']);
  expect(jobs).toHaveLength(1);
});
```

The first test is the whole justification for the sweeper: it reproduces the
crash between commit and enqueue and shows the system heals.

The second test is why this plan does **not** use Plan 6's suggested SQL
(`JOIN appointments WHERE status = 'CANCELLED'`). A cancelled row plus a later
confirmed rebooking would still match that join, and the sweeper would enqueue
a no-op job forever. "Is the slot free?" means no overlapping CONFIRMED
appointment, which is exactly `findSlotsWithWaiters`.

- [ ] **Step 2: Implement the adapter**

```ts
// src/waiting-list/waiting-list-reconciler.adapter.ts
import { Injectable } from '@nestjs/common';
import {
  StrandedSlot,
  WaitingListReconciler,
} from '../jobs/waiting-list-reconciler';
import { WaitingListRepository } from './waiting-list.repository';

@Injectable()
export class WaitingListReconcilerAdapter extends WaitingListReconciler {
  constructor(private readonly entries: WaitingListRepository) {
    super();
  }

  async findStrandedSlots(_now: Date, limit: number): Promise<StrandedSlot[]> {
    // SlotWithWaiters is structurally identical to StrandedSlot.
    return this.entries.findSlotsWithWaiters(limit);
  }

  expireStale(now: Date): Promise<number> {
    return this.entries.expireStale(now);
  }
}
```

The `_now` argument is unused because `findSlotsWithWaiters` already filters
`slot_start_at > now()` in SQL. Keep the signature so the port does not change.

- [ ] **Step 3: Swap the binding in `ProcessorsModule`**

In `src/jobs/processors.module.ts`, import `WaitingListModule` and replace

```ts
{ provide: WaitingListReconciler, useClass: NoWaitingListReconciler }
```

with

```ts
{ provide: WaitingListReconciler, useClass: WaitingListReconcilerAdapter }
```

Add `WaitingListReconcilerAdapter` to providers. Do not remove
`NoWaitingListReconciler` from the codebase — tests that boot the API without
the waiting-list table still use it.

The sweeper itself already calls `waitingListReconciler.findStrandedSlots` and
`expireStale`, then `JobsService.enqueueSlotProcessing`. Those paths were
tested against a stub in Plan 6; this task is what makes them real.

- [ ] **Step 4: Run the tests and commit**

```bash
npm run test:e2e -- reconciliation
git add src/waiting-list/waiting-list-reconciler.adapter.ts src/jobs/processors.module.ts test/reconciliation.e2e-spec.ts
git commit -m "feat(jobs): recover stranded waiting-list assignments in the sweeper"
```

---

## Task 7: End-to-end scenario for the recording

**Files:**
- Create: `scripts/waiting-list-demo.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run demo:waiting-list`, a narrated end-to-end run suitable for
  the screen recording.

- [ ] **Step 1: Write the demo script**

```ts
// scripts/waiting-list-demo.ts
/**
 * End-to-end waiting list demonstration, for the screen recording.
 *
 * 1. Patient A books a slot.
 * 2. Patient B tries the same slot and is told it is taken.
 * 3. Patient B joins the waiting list and sees position 1.
 * 4. Patient A cancels.
 * 5. The background job assigns the slot to Patient B.
 * 6. Patient B's appointment exists with created_from = WAITING_LIST,
 *    and has its own reminder notification.
 *
 * Every step prints what it did and what it expected, so the recording needs
 * no editing and no separate narration of the mechanics.
 */
```

Implement it with the same `fetch` helpers as `scripts/concurrency-test.ts`:
create a doctor and schedule via admin, register two patients, run the six steps
with a `console.log` before each, poll `GET /appointments/me` for Patient B for
up to ten seconds after the cancellation, then print the final database rows for
the appointment and its notifications. Exit non-zero if the assignment did not
happen.

Polling rather than a fixed `sleep`: the sweeper runs every 60 seconds and the
direct enqueue is near-instant, so a fixed wait would be either flaky or
needlessly slow.

- [ ] **Step 2: Add the script**

```json
"demo:waiting-list": "ts-node -r tsconfig-paths/register scripts/waiting-list-demo.ts"
```

- [ ] **Step 3: Run it against the full stack**

```bash
docker compose up --build -d
npm run seed:admin
npm run demo:waiting-list
```

Expected: all six steps print success, and the final output shows Patient B's
appointment with `created_from: WAITING_LIST` plus a PENDING `REMINDER` and a
`WAITLIST_ASSIGNED` notification.

- [ ] **Step 4: Commit**

```bash
git add scripts/waiting-list-demo.ts package.json
git commit -m "chore(scripts): add end-to-end waiting list demonstration"
```

---

## Definition of Done

- [ ] The raw SQL checks in Task 1 Step 5 behave as described.
- [ ] `npm test` and `npm run test:e2e` pass.
- [ ] Joining a free slot returns 409 `SLOT_IS_AVAILABLE`.
- [ ] A duplicate join returns 409 `ALREADY_IN_WAITING_LIST`.
- [ ] Leaving then rejoining the same slot succeeds.
- [ ] Assignment follows FIFO, not reverse order.
- [ ] A candidate busy elsewhere is skipped, stays `WAITING`, and the next
      candidate gets the slot.
- [ ] Running the processor twice produces exactly one appointment and one
      `ASSIGNED` entry.
- [ ] A direct booking winning the race leaves the processor a successful no-op.
- [ ] The assigned appointment has `created_from = 'WAITING_LIST'` and its own
      `REMINDER` notification.
- [ ] The sweeper recovers a cancellation whose enqueue never happened.
- [ ] `npm run demo:waiting-list` completes end to end.
- [ ] `grep -rn "WaitingListModule" src/appointments/` returns nothing —
      the dependency stays one-directional.
- [ ] `grep -rn "ProcessorsModule" src/app.module.ts` returns nothing —
      the API is not a job runner.
- [ ] `grep -n "@Processor" src/jobs/jobs.module.ts` returns nothing.

---

## Next

Plan 8 (Analytics) and Plan 9 (Seed, performance evidence, README). The README's
waiting-list assumptions section comes from the assumption list at the top of
this plan and from `docs/DECISIONS.md` entries 5 and 16.
