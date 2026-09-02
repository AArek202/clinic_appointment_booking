# Background Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** BullMQ job processing on Redis, running in its own `worker` container:
the `notifications` table and repository, the appointment reminder job, and a
repeatable reconciliation sweeper that re-derives lost work from PostgreSQL.

**Architecture:** PostgreSQL is the store of record; Redis is only a scheduler.
Business rows (`notifications`) are written inside the business transaction, the
BullMQ job is enqueued *after* commit, job payloads carry identifiers only, and
a sweeper running every 60 seconds re-derives anything that committed but was
never enqueued. Every job re-reads its subject from the database, so a retry
acts on current data.

**Tech Stack:** NestJS 11, `@nestjs/bullmq` + `bullmq` (>= 5.16 for
`upsertJobScheduler`), `ioredis`, Redis 7, PostgreSQL 16, TypeORM, Jest 30.

## Global Constraints

- `synchronize: true` is forbidden in every environment, including tests. All
  schema changes go through migrations. (`docs/STACK.md`)
- No file under `src/` calls `new Date()`. Time comes from the injected `Clock`
  from Plan 1. (`docs/ARCHITECTURE.md`)
- **Jobs are enqueued only after the transaction commits — never inside it.**
  (`docs/DECISIONS.md` #6)
- **Job payloads carry identifiers only, never state.** Workers re-derive every
  decision from the database. (`docs/PLANS/00-interfaces.md`, Queue Contract)
- Queue names, job names, payload interfaces and job-id helpers are exactly as
  written in `docs/PLANS/00-interfaces.md` § *Queue Contract (Plan 6)*. That
  file wins on any disagreement.
- `notifications_unique_per_type` is `UNIQUE (appointment_id, type)`.
  (`docs/PLANS/00-interfaces.md` § *Database Constraint Names*)
- The reconciliation sweeper interval is **60 000 ms**
  (`RECONCILE_EVERY_MS`). (`docs/DECISIONS.md` #17)
- Workers run as a **separate service** from the API. Processors must never be
  registered in the API bootstrap. (`docs/DECISIONS.md` #13)
- Redis runs without persistence and without a volume. Delayed jobs are timers,
  not records; the sweeper re-derives them. (`docs/DECISIONS.md` #14)
- Every migration is reversible, and reversibility is verified before commit.
- Commit messages follow `docs/DEVELOPMENT.md`, e.g.
  `feat(jobs): add appointment reminder processor`.
- Node 22 LTS.

### Additions to the Queue Contract made by this plan

`docs/PLANS/00-interfaces.md` does not name everything the sweeper needs. These
three symbols are **added** to `src/jobs/queue.constants.ts` (nothing in the
contract is changed or contradicted), and should be copied back into
`00-interfaces.md` § *Queue Contract (Plan 6)* when this plan is executed:

```ts
export const RECONCILE_SCHEDULER_ID = 'reconcile-sweeper';
export const RECONCILE_BATCH_LIMIT = 100;
export function sweepReminderJobId(appointmentId: string, now: Date): string;
```

---

## File Structure

**Created by this plan:**

```text
src/common/enums/
  notification-type.enum.ts      NotificationType
  notification-status.enum.ts    NotificationStatus

src/notifications/
  notification.entity.ts         the notifications table
  notifications.repository.ts    createPending / markSentIfPending / findDuePending
  notifications.module.ts

src/database/migrations/
  1756830000000-CreateNotifications.ts

src/jobs/
  queue.constants.ts             queue + job names, payloads, job-id helpers
  jobs.service.ts                the ONLY place a job is enqueued
  jobs.module.ts                 Redis connection + the three queues (API + worker)
  processors.module.ts           the processors (worker process only)
  appointment-reminder.processor.ts
  reconciliation.processor.ts
  reconcile.scheduler.ts         registers the repeatable sweeper on worker boot
  waiting-list-reconciler.ts     port + no-op impl; Plan 7 replaces the binding

src/worker.module.ts             root module of the worker process
src/worker.ts                    worker bootstrap (no HTTP server)

test/
  job-fixtures.ts                raw-SQL fixtures + a test DataSource factory
  redis-helper.ts                Redis isolation guard, flush, waitFor
  notifications-schema.e2e-spec.ts
  notifications-repository.e2e-spec.ts
  appointment-reminder.e2e-spec.ts
  reminder-queue.e2e-spec.ts
  reconciliation.e2e-spec.ts
```

**Modified:** `package.json` (dependencies + `start:worker` scripts),
`.env.example` (`TEST_REDIS_URL`), `test/setup-db.ts` (point the suite at an
isolated Redis database), `test/jest-e2e.json` (`testTimeout`),
`docker-compose.yml` (the `worker` service), `src/app.module.ts`.

`src/app.module.ts` gains `NotificationsModule` (Task 2) and `JobsModule`
(Task 3), and nothing else. It must never import `ProcessorsModule` — keeping
the API a pure producer is the whole point of decision #13.

Responsibility split: `notifications/` owns one table and the idempotency
primitives. `jobs/` owns queue names, enqueueing and the processors. The split
between `JobsModule` (queues, imported by both processes) and `ProcessorsModule`
(workers, imported by the worker process only) is what keeps the API from
silently becoming a job runner when it scales to two replicas.

---

## The correctness argument, stated once

Every task below implements a piece of this. Read it first; it is what the plan
is for.

**1. PostgreSQL and Redis cannot commit together.** There is no shared
transaction, so only two orderings exist and both can fail:

- *Enqueue inside the transaction.* The worker can dequeue and start running
  before the transaction commits, or after it rolls back. It reads an
  appointment that is not cancelled yet, correctly decides there is nothing to
  do, and exits successfully. The work is lost permanently and leaves no trace.
- *Enqueue after the transaction commits.* If the process dies in the gap
  between `COMMIT` and `queue.add`, the job never exists. The commit is real and
  the follow-up never happens.

**2. The chosen answer is: enqueue after commit, then sweep.** Enqueue-after-
commit loses jobs only in a crash window of a few milliseconds, and — unlike
enqueue-inside-transaction — the *database still records the intent*. A
`notifications` row with `status = 'PENDING'` and a `scheduled_at` in the past is
a durable, queryable description of undone work. The sweeper re-derives exactly
that set every 60 seconds, so a lost job costs a bounded delay instead of
silence. It also covers a case no enqueue ordering can: delayed BullMQ jobs live
only in Redis, and Redis runs without persistence, so `docker compose restart
redis` drops the whole delayed set. That is why the sweeper queries
`notifications` rather than inspecting the queue.

**3. Transactional outbox: considered, rejected.** Writing job intents to an
`outbox` table in the same transaction and draining it with a poller is strictly
stronger — the intent and the state change commit atomically, so nothing can
ever be lost. It is rejected as disproportionate here: it means building,
testing and explaining a second queueing mechanism on top of the one the task
asks for, to close a window the sweeper already covers. Recorded in the README
as the alternative considered. (`docs/DECISIONS.md` #6)

**4. Payloads carry identifiers only.** `SendReminderJobData` is
`{ appointmentId }`, not `{ appointmentId, patientName, startAt }`. A job may
run minutes or hours after it was enqueued, and may run twice. If the payload
carried "this appointment is CONFIRMED", a retry would act on a snapshot that
is no longer true. Re-reading is the cheap half of the fix.

**5. Idempotency is a unique constraint *plus* a conditional update.**
`UNIQUE (appointment_id, type)` makes a duplicate row impossible. That alone is
not enough, because the dangerous duplicate is not a second row — it is a second
*send*. Two workers both running

```text
SELECT status FROM notifications WHERE ...   -- both read 'PENDING'
UPDATE notifications SET status = 'SENT' ...  -- both then send
```

each observe PENDING and each send a reminder. Read-then-write is itself the
race. So the transition is one statement whose `WHERE` clause contains the
precondition, and the worker branches on how many rows it affected:

```sql
UPDATE notifications
   SET status = 'SENT', sent_at = now()
 WHERE appointment_id = $1
   AND type = $2
   AND status = 'PENDING'
RETURNING id;
```

Zero rows means somebody else already sent it; the job exits successfully and
sends nothing. Under concurrency PostgreSQL row-locks the second `UPDATE` until
the first commits, then re-evaluates the `WHERE` against the new row version and
matches nothing. That re-evaluation is what makes "no double reminders" a
guarantee rather than a hope.

**6. A cancelled appointment must not send a reminder, and job removal is not
how that is achieved.** Removal can fail, the worker may already be executing
the job, and Redis may have been restarted with a stale copy. The guarantee is
that the worker re-reads `appointments.status` at execution time and exits when
it is not `CONFIRMED`. `JobsService.removeReminder` exists only to keep the
delayed set tidy, swallows its own errors, and is never relied upon.

---

## Task 1: The `notifications` table

The row is the source of truth for a reminder; the queue is only the trigger.
This table is therefore built before anything that enqueues.

**Files:**
- Create: `src/common/enums/notification-type.enum.ts`
- Create: `src/common/enums/notification-status.enum.ts`
- Create: `src/notifications/notification.entity.ts`
- Create: `src/database/migrations/1756830000000-CreateNotifications.ts`
- Create: `test/job-fixtures.ts`
- Test: `test/notifications-schema.e2e-spec.ts`

**Interfaces:**
- Consumes: `appointments` and `patients` tables and the `Appointment` entity
  (Plan 5); `src/common/errors/database-error.ts` helpers `getSqlState`,
  `getConstraintName` and the constant `PG_UNIQUE_VIOLATION` (Plan 5); the e2e
  harness `test/setup-db.ts` (Plan 1).
- Produces: enums `NotificationType` (`Reminder = 'REMINDER'`,
  `WaitlistAssigned = 'WAITLIST_ASSIGNED'`) and `NotificationStatus`
  (`Pending = 'PENDING'`, `Sent = 'SENT'`); entity `Notification` with
  properties `id`, `appointmentId`, `patientId`, `type`, `status`,
  `scheduledAt`, `sentAt`, `createdAt`; the constraint
  `notifications_unique_per_type`; and these test helpers in
  `test/job-fixtures.ts`:

```ts
createTestDataSource(): DataSource
resetJobTables(dataSource: DataSource): Promise<void>
seedPatient(dataSource: DataSource): Promise<string>            // patient id
seedDoctor(dataSource: DataSource): Promise<string>             // doctor id
seedConfirmedAppointment(
  dataSource: DataSource,
  params: { startAt: Date; endAt: Date },
): Promise<SeededSlot>   // { doctorId, patientId, appointmentId, startAt, endAt }
cancelAppointment(dataSource: DataSource, appointmentId: string): Promise<void>
insertPendingReminder(
  dataSource: DataSource,
  params: { appointmentId: string; patientId: string; scheduledAt: Date },
): Promise<string>       // notification id
```

- [ ] **Step 1: Write the enums**

Create `src/common/enums/notification-type.enum.ts`:

```ts
export enum NotificationType {
  Reminder = 'REMINDER',
  WaitlistAssigned = 'WAITLIST_ASSIGNED',
}
```

Create `src/common/enums/notification-status.enum.ts`:

```ts
export enum NotificationStatus {
  Pending = 'PENDING',
  Sent = 'SENT',
}
```

One table with a `type` column rather than separate `reminders` and
`waitlist_notifications` tables: both job types need the same "have we already
done this?" check, so they share one unique constraint and one conditional
update instead of implementing idempotency twice
(`docs/DECISIONS.md` #7).

- [ ] **Step 2: Write the test fixtures helper**

Create `test/job-fixtures.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

export interface SeededSlot {
  doctorId: string;
  patientId: string;
  appointmentId: string;
  startAt: Date;
  endAt: Date;
}

/**
 * A DataSource pointed at the test database.
 *
 * `test/setup-db.ts` rewrites DATABASE_URL to TEST_DATABASE_URL in Jest's
 * globalSetup, which runs before the workers fork, so process.env here is
 * already the test database.
 */
export function createTestDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    entities: ['src/**/*.entity.ts'],
    synchronize: false,
  });
}

/**
 * Empties every table the job tests write to.
 *
 * Order does not matter because of CASCADE, and CASCADE also covers tables
 * added by later plans (waiting_list) without editing this list.
 */
export async function resetJobTables(dataSource: DataSource): Promise<void> {
  await dataSource.query(
    'TRUNCATE notifications, appointments, patients, doctors, users CASCADE',
  );
}

async function insertUser(dataSource: DataSource, role: string): Promise<string> {
  const [row]: Array<{ id: string }> = await dataSource.query(
    `INSERT INTO users (first_name, last_name, email, password_hash, role, created_at, updated_at)
     VALUES ($1, $2, $3, 'not-a-real-hash', $4, now(), now())
     RETURNING id`,
    ['Test', role, `${role.toLowerCase()}-${randomUUID()}@example.test`, role],
  );
  return row.id;
}

export async function seedPatient(dataSource: DataSource): Promise<string> {
  const userId = await insertUser(dataSource, 'PATIENT');
  const [row]: Array<{ id: string }> = await dataSource.query(
    `INSERT INTO patients (user_id, has_insurance) VALUES ($1, false) RETURNING id`,
    [userId],
  );
  return row.id;
}

export async function seedDoctor(dataSource: DataSource): Promise<string> {
  const userId = await insertUser(dataSource, 'DOCTOR');
  const [row]: Array<{ id: string }> = await dataSource.query(
    `INSERT INTO doctors (user_id, specialization) VALUES ($1, 'General') RETURNING id`,
    [userId],
  );
  return row.id;
}

/** A CONFIRMED, DIRECT appointment plus the doctor and patient it needs. */
export async function seedConfirmedAppointment(
  dataSource: DataSource,
  params: { startAt: Date; endAt: Date },
): Promise<SeededSlot> {
  const doctorId = await seedDoctor(dataSource);
  const patientId = await seedPatient(dataSource);

  const [row]: Array<{ id: string }> = await dataSource.query(
    `INSERT INTO appointments
       (doctor_id, patient_id, start_at, end_at, status, created_from, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'CONFIRMED', 'DIRECT', now(), now())
     RETURNING id`,
    [doctorId, patientId, params.startAt, params.endAt],
  );

  return {
    doctorId,
    patientId,
    appointmentId: row.id,
    startAt: params.startAt,
    endAt: params.endAt,
  };
}

export async function cancelAppointment(
  dataSource: DataSource,
  appointmentId: string,
): Promise<void> {
  await dataSource.query(
    `UPDATE appointments SET status = 'CANCELLED', cancelled_at = now(), updated_at = now()
      WHERE id = $1`,
    [appointmentId],
  );
}

export async function insertPendingReminder(
  dataSource: DataSource,
  params: { appointmentId: string; patientId: string; scheduledAt: Date },
): Promise<string> {
  const [row]: Array<{ id: string }> = await dataSource.query(
    `INSERT INTO notifications (appointment_id, patient_id, type, status, scheduled_at)
     VALUES ($1, $2, 'REMINDER', 'PENDING', $3)
     RETURNING id`,
    [params.appointmentId, params.patientId, params.scheduledAt],
  );
  return row.id;
}
```

Raw SQL rather than entity `save()` calls, deliberately: these fixtures must
keep working regardless of what Plan 5's own test helpers look like, and they
document the exact column names the migration has to produce.

- [ ] **Step 3: Write the failing schema test**

Create `test/notifications-schema.e2e-spec.ts`:

```ts
import { DataSource } from 'typeorm';
import {
  PG_UNIQUE_VIOLATION,
  getConstraintName,
  getSqlState,
} from '../src/common/errors/database-error';
import {
  createTestDataSource,
  insertPendingReminder,
  resetJobTables,
  seedConfirmedAppointment,
} from './job-fixtures';

const START_AT = new Date('2026-10-01T09:00:00.000Z');
const END_AT = new Date('2026-10-01T09:30:00.000Z');

describe('notifications schema', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await createTestDataSource().initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await resetJobTables(dataSource);
  });

  it('allows one notification per (appointment, type)', async () => {
    const slot = await seedConfirmedAppointment(dataSource, {
      startAt: START_AT,
      endAt: END_AT,
    });

    const id = await insertPendingReminder(dataSource, {
      appointmentId: slot.appointmentId,
      patientId: slot.patientId,
      scheduledAt: new Date('2026-09-30T09:00:00.000Z'),
    });

    expect(id).toBeDefined();
  });

  it('rejects a second notification of the same type for one appointment', async () => {
    const slot = await seedConfirmedAppointment(dataSource, {
      startAt: START_AT,
      endAt: END_AT,
    });
    const scheduledAt = new Date('2026-09-30T09:00:00.000Z');

    await insertPendingReminder(dataSource, {
      appointmentId: slot.appointmentId,
      patientId: slot.patientId,
      scheduledAt,
    });

    expect.assertions(2);
    try {
      await insertPendingReminder(dataSource, {
        appointmentId: slot.appointmentId,
        patientId: slot.patientId,
        scheduledAt,
      });
    } catch (error) {
      expect(getSqlState(error)).toBe(PG_UNIQUE_VIOLATION);
      expect(getConstraintName(error)).toBe('notifications_unique_per_type');
    }
  });

  it('allows two different types for the same appointment', async () => {
    const slot = await seedConfirmedAppointment(dataSource, {
      startAt: START_AT,
      endAt: END_AT,
    });

    await dataSource.query(
      `INSERT INTO notifications (appointment_id, patient_id, type, status, scheduled_at)
       VALUES ($1, $2, 'REMINDER', 'PENDING', now()),
              ($1, $2, 'WAITLIST_ASSIGNED', 'PENDING', now())`,
      [slot.appointmentId, slot.patientId],
    );

    const [{ count }]: Array<{ count: string }> = await dataSource.query(
      'SELECT count(*)::text AS count FROM notifications',
    );
    expect(count).toBe('2');
  });

  it('rejects an unknown type', async () => {
    const slot = await seedConfirmedAppointment(dataSource, {
      startAt: START_AT,
      endAt: END_AT,
    });

    await expect(
      dataSource.query(
        `INSERT INTO notifications (appointment_id, patient_id, type, status, scheduled_at)
         VALUES ($1, $2, 'SMOKE_SIGNAL', 'PENDING', now())`,
        [slot.appointmentId, slot.patientId],
      ),
    ).rejects.toThrow(/notifications_type_valid/);
  });

  it('rejects a SENT row without a sent_at', async () => {
    const slot = await seedConfirmedAppointment(dataSource, {
      startAt: START_AT,
      endAt: END_AT,
    });

    await expect(
      dataSource.query(
        `INSERT INTO notifications (appointment_id, patient_id, type, status, scheduled_at)
         VALUES ($1, $2, 'REMINDER', 'SENT', now())`,
        [slot.appointmentId, slot.patientId],
      ),
    ).rejects.toThrow(/notifications_sent_at_consistent/);
  });
});
```

The last test is the one that pays off later. `status = 'SENT'` with a null
`sent_at` is the shape a half-finished manual fix leaves behind, and it would
make every "when was this sent?" answer a lie.

- [ ] **Step 4: Run the test to verify it fails**

```bash
docker compose up -d postgres redis
docker compose --profile test up -d postgres-test
npx jest --config test/jest-e2e.json test/notifications-schema.e2e-spec.ts
```

Expected: FAIL — `relation "notifications" does not exist`.

- [ ] **Step 5: Write the migration**

Create `src/database/migrations/1756830000000-CreateNotifications.ts`:

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateNotifications1756830000000 implements MigrationInterface {
  name = 'CreateNotifications1756830000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE notifications (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        appointment_id uuid NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
        patient_id     uuid NOT NULL REFERENCES patients (id),
        type           text NOT NULL,
        status         text NOT NULL DEFAULT 'PENDING',
        scheduled_at   timestamptz NOT NULL,
        sent_at        timestamptz,
        created_at     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT notifications_unique_per_type UNIQUE (appointment_id, type),
        CONSTRAINT notifications_type_valid
          CHECK (type IN ('REMINDER', 'WAITLIST_ASSIGNED')),
        CONSTRAINT notifications_status_valid
          CHECK (status IN ('PENDING', 'SENT')),
        CONSTRAINT notifications_sent_at_consistent
          CHECK ((status = 'SENT') = (sent_at IS NOT NULL))
      )
    `);

    await queryRunner.query(`
      COMMENT ON CONSTRAINT notifications_unique_per_type ON notifications IS
        'Idempotency key for background jobs: one notification of each type per appointment, ever.'
    `);

    // The reconciliation sweeper's only query: due-but-unsent notifications.
    // docs/DATABASE.md lists this as (status, scheduled_at); under the partial
    // predicate `status` is a constant, so it is dropped from the key. Same
    // plan, smaller index.
    await queryRunner.query(`
      CREATE INDEX notifications_pending_due_idx
        ON notifications (scheduled_at)
        WHERE status = 'PENDING'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS notifications_pending_due_idx`);
    await queryRunner.query(`DROP TABLE IF EXISTS notifications`);
  }
}
```

Enums are `text` with a `CHECK` rather than native PostgreSQL enums: adding a
value to a native enum needs `ALTER TYPE`, which makes migrations awkward, while
a `CHECK` is trivially alterable and just as strict
(`docs/PLANS/00-interfaces.md` § *Enums*).

The timestamp `1756830000000` must sort **after** every migration created by
Plans 2–5. Check `ls src/database/migrations` first; if a higher prefix already
exists, raise this one and rename the class to match. TypeORM orders migrations
by that numeric prefix, and the foreign keys require `appointments` and
`patients` to exist already.

- [ ] **Step 6: Run the migration and verify the schema**

```bash
npm run migration:run
docker compose exec postgres psql -U clinic -d clinic -c "\d notifications"
```

Expected: `Migration CreateNotifications1756830000000 has been executed successfully.`
and the `\d` output lists `notifications_unique_per_type`,
`notifications_pending_due_idx` and the three check constraints.

- [ ] **Step 7: Verify the migration is reversible**

```bash
npm run migration:revert
docker compose exec postgres psql -U clinic -d clinic -c "SELECT count(*) FROM information_schema.tables WHERE table_name = 'notifications';"
npm run migration:run
```

Expected: count `0` after the revert, and the re-run succeeds. A migration that
cannot be reverted is not finished.

- [ ] **Step 8: Write the entity**

Create `src/notifications/notification.entity.ts`:

```ts
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { NotificationStatus } from '../common/enums/notification-status.enum';
import { NotificationType } from '../common/enums/notification-type.enum';

@Entity('notifications')
@Index('notifications_unique_per_type', ['appointmentId', 'type'], { unique: true })
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'appointment_id', type: 'uuid' })
  appointmentId!: string;

  @Column({ name: 'patient_id', type: 'uuid' })
  patientId!: string;

  @Column({ type: 'text' })
  type!: NotificationType;

  @Column({ type: 'text', default: NotificationStatus.Pending })
  status!: NotificationStatus;

  @Column({ name: 'scheduled_at', type: 'timestamptz' })
  scheduledAt!: Date;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx jest --config test/jest-e2e.json test/notifications-schema.e2e-spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 10: Commit**

```bash
git add src/common/enums src/notifications src/database/migrations test/job-fixtures.ts test/notifications-schema.e2e-spec.ts
git commit -m "feat(notifications): add notifications table with idempotency constraint"
```

---

## Task 2: `NotificationsRepository`

The two primitives every job depends on: write the intent inside a transaction,
and flip it to SENT exactly once.

**Files:**
- Create: `src/notifications/notifications.repository.ts`
- Create: `src/notifications/notifications.module.ts`
- Test: `test/notifications-repository.e2e-spec.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `Notification` (Task 1); `Appointment` and `AppointmentStatus`
  (Plan 5); `AppConfigModule` and `DatabaseModule` (Plan 1).
- Produces: `NotificationsRepository` with exactly the three methods in
  `docs/PLANS/00-interfaces.md`:

```ts
createPending(
  manager: EntityManager,
  params: {
    appointmentId: string;
    patientId: string;
    type: NotificationType;
    scheduledAt: Date;
  },
): Promise<Notification>

markSentIfPending(appointmentId: string, type: NotificationType): Promise<boolean>

findDuePending(now: Date, limit: number): Promise<Notification[]>
```

  and `NotificationsModule`, which exports `NotificationsRepository`.

**Plan 5 integration point.** `AppointmentsService.book()` calls
`createPending(manager, { appointmentId, patientId, type:
NotificationType.Reminder, scheduledAt })` **inside** its booking transaction,
with `scheduledAt = startAt - REMINDER_LEAD_HOURS`, and then calls
`JobsService.scheduleReminder(appointmentId, scheduledAt)` **after** commit
(Task 3). `manager` is a parameter rather than an injected repository precisely
so the row joins the caller's transaction and rolls back with it.

- [ ] **Step 1: Write the failing test**

Create `test/notifications-repository.e2e-spec.ts`:

```ts
import { TestingModule, Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/database/database.module';
import { NotificationStatus } from '../src/common/enums/notification-status.enum';
import { NotificationType } from '../src/common/enums/notification-type.enum';
import { NotificationsModule } from '../src/notifications/notifications.module';
import { NotificationsRepository } from '../src/notifications/notifications.repository';
import {
  cancelAppointment,
  insertPendingReminder,
  resetJobTables,
  seedConfirmedAppointment,
} from './job-fixtures';

const START_AT = new Date('2026-10-01T09:00:00.000Z');
const END_AT = new Date('2026-10-01T09:30:00.000Z');
const SCHEDULED_AT = new Date('2026-09-30T09:00:00.000Z');
const NOW = new Date('2026-09-30T10:00:00.000Z');

describe('NotificationsRepository', () => {
  let moduleRef: TestingModule;
  let repository: NotificationsRepository;
  let dataSource: DataSource;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule, NotificationsModule],
    }).compile();

    repository = moduleRef.get(NotificationsRepository);
    dataSource = moduleRef.get(DataSource);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await resetJobTables(dataSource);
  });

  describe('createPending', () => {
    it('writes a PENDING row inside the caller transaction', async () => {
      const slot = await seedConfirmedAppointment(dataSource, {
        startAt: START_AT,
        endAt: END_AT,
      });

      const created = await dataSource.transaction((manager) =>
        repository.createPending(manager, {
          appointmentId: slot.appointmentId,
          patientId: slot.patientId,
          type: NotificationType.Reminder,
          scheduledAt: SCHEDULED_AT,
        }),
      );

      expect(created.status).toBe(NotificationStatus.Pending);
      expect(created.sentAt).toBeNull();
      expect(created.scheduledAt).toEqual(SCHEDULED_AT);
    });

    it('rolls back with the caller transaction', async () => {
      const slot = await seedConfirmedAppointment(dataSource, {
        startAt: START_AT,
        endAt: END_AT,
      });

      await expect(
        dataSource.transaction(async (manager) => {
          await repository.createPending(manager, {
            appointmentId: slot.appointmentId,
            patientId: slot.patientId,
            type: NotificationType.Reminder,
            scheduledAt: SCHEDULED_AT,
          });
          throw new Error('booking failed after the notification was written');
        }),
      ).rejects.toThrow('booking failed');

      const [{ count }]: Array<{ count: string }> = await dataSource.query(
        'SELECT count(*)::text AS count FROM notifications',
      );
      expect(count).toBe('0');
    });
  });

  describe('markSentIfPending', () => {
    it('returns true once and false afterwards', async () => {
      const slot = await seedConfirmedAppointment(dataSource, {
        startAt: START_AT,
        endAt: END_AT,
      });
      await insertPendingReminder(dataSource, {
        appointmentId: slot.appointmentId,
        patientId: slot.patientId,
        scheduledAt: SCHEDULED_AT,
      });

      const first = await repository.markSentIfPending(
        slot.appointmentId,
        NotificationType.Reminder,
      );
      const second = await repository.markSentIfPending(
        slot.appointmentId,
        NotificationType.Reminder,
      );

      expect(first).toBe(true);
      expect(second).toBe(false);

      const [row]: Array<{ status: string; sent_at: Date }> = await dataSource.query(
        'SELECT status, sent_at FROM notifications WHERE appointment_id = $1',
        [slot.appointmentId],
      );
      expect(row.status).toBe('SENT');
      expect(row.sent_at).not.toBeNull();
    });

    it('returns false when there is no notification at all', async () => {
      const result = await repository.markSentIfPending(
        '00000000-0000-0000-0000-000000000000',
        NotificationType.Reminder,
      );

      expect(result).toBe(false);
    });

    it('lets exactly one of five concurrent callers win', async () => {
      const slot = await seedConfirmedAppointment(dataSource, {
        startAt: START_AT,
        endAt: END_AT,
      });
      await insertPendingReminder(dataSource, {
        appointmentId: slot.appointmentId,
        patientId: slot.patientId,
        scheduledAt: SCHEDULED_AT,
      });

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          repository.markSentIfPending(slot.appointmentId, NotificationType.Reminder),
        ),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });

  describe('findDuePending', () => {
    it('returns due PENDING notifications for CONFIRMED appointments only', async () => {
      const due = await seedConfirmedAppointment(dataSource, {
        startAt: START_AT,
        endAt: END_AT,
      });
      const cancelled = await seedConfirmedAppointment(dataSource, {
        startAt: START_AT,
        endAt: END_AT,
      });
      const future = await seedConfirmedAppointment(dataSource, {
        startAt: START_AT,
        endAt: END_AT,
      });

      await insertPendingReminder(dataSource, {
        appointmentId: due.appointmentId,
        patientId: due.patientId,
        scheduledAt: SCHEDULED_AT,
      });
      await insertPendingReminder(dataSource, {
        appointmentId: cancelled.appointmentId,
        patientId: cancelled.patientId,
        scheduledAt: SCHEDULED_AT,
      });
      await insertPendingReminder(dataSource, {
        appointmentId: future.appointmentId,
        patientId: future.patientId,
        scheduledAt: new Date('2026-12-01T09:00:00.000Z'),
      });
      await cancelAppointment(dataSource, cancelled.appointmentId);

      const rows = await repository.findDuePending(NOW, 10);

      expect(rows.map((row) => row.appointmentId)).toEqual([due.appointmentId]);
    });

    it('excludes notifications that were already sent', async () => {
      const slot = await seedConfirmedAppointment(dataSource, {
        startAt: START_AT,
        endAt: END_AT,
      });
      await insertPendingReminder(dataSource, {
        appointmentId: slot.appointmentId,
        patientId: slot.patientId,
        scheduledAt: SCHEDULED_AT,
      });
      await repository.markSentIfPending(slot.appointmentId, NotificationType.Reminder);

      await expect(repository.findDuePending(NOW, 10)).resolves.toEqual([]);
    });

    it('honours the limit', async () => {
      for (let index = 0; index < 3; index += 1) {
        const slot = await seedConfirmedAppointment(dataSource, {
          startAt: START_AT,
          endAt: END_AT,
        });
        await insertPendingReminder(dataSource, {
          appointmentId: slot.appointmentId,
          patientId: slot.patientId,
          scheduledAt: SCHEDULED_AT,
        });
      }

      await expect(repository.findDuePending(NOW, 2)).resolves.toHaveLength(2);
    });
  });
});
```

`lets exactly one of five concurrent callers win` is the most important test in
this plan. Each call runs on its own pooled connection, so PostgreSQL really
does have to arbitrate: the first `UPDATE` takes the row lock, the other four
block, and when the lock is released they re-evaluate `status = 'PENDING'`
against the committed row and match nothing. A "check then update"
implementation passes every other test in this file and fails this one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest --config test/jest-e2e.json test/notifications-repository.e2e-spec.ts`
Expected: FAIL — `Cannot find module '../src/notifications/notifications.module'`.

- [ ] **Step 3: Implement the repository**

Create `src/notifications/notifications.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Appointment } from '../appointments/appointment.entity';
import { AppointmentStatus } from '../common/enums/appointment-status.enum';
import { NotificationStatus } from '../common/enums/notification-status.enum';
import { NotificationType } from '../common/enums/notification-type.enum';
import { Notification } from './notification.entity';

@Injectable()
export class NotificationsRepository {
  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
  ) {}

  /**
   * Writes the PENDING intent using the caller's EntityManager, so the row
   * commits and rolls back with the business transaction that created it.
   * The row — not the BullMQ job — is the source of truth.
   */
  async createPending(
    manager: EntityManager,
    params: {
      appointmentId: string;
      patientId: string;
      type: NotificationType;
      scheduledAt: Date;
    },
  ): Promise<Notification> {
    const notification = manager.create(Notification, {
      appointmentId: params.appointmentId,
      patientId: params.patientId,
      type: params.type,
      status: NotificationStatus.Pending,
      scheduledAt: params.scheduledAt,
      sentAt: null,
    });

    return manager.save(notification);
  }

  /**
   * Atomically transitions PENDING -> SENT.
   *
   * Returns false when no row was affected, meaning another worker already
   * sent it. Callers must exit successfully on false, never retry.
   *
   * One statement with the precondition in the WHERE clause. Reading the
   * status and then writing it would be a race between two workers: both
   * would read PENDING and both would send.
   */
  async markSentIfPending(
    appointmentId: string,
    type: NotificationType,
  ): Promise<boolean> {
    const result: unknown = await this.notifications.manager.query(
      `UPDATE notifications
          SET status = 'SENT', sent_at = now()
        WHERE appointment_id = $1
          AND type = $2
          AND status = 'PENDING'
       RETURNING id`,
      [appointmentId, type],
    );

    // TypeORM's Postgres driver returns [rows, affectedCount] for UPDATE and
    // DELETE, but a bare rows array for everything else. Normalise both so a
    // driver upgrade cannot silently turn this into "always true".
    const rows = Array.isArray((result as unknown[])[0])
      ? ((result as unknown[])[0] as unknown[])
      : (result as unknown[]);

    return rows.length > 0;
  }

  /**
   * Notifications that are still PENDING, are due, and whose appointment is
   * still CONFIRMED. Used only by the reconciliation sweeper: this is the
   * database's own description of work that was committed but never delivered.
   */
  async findDuePending(now: Date, limit: number): Promise<Notification[]> {
    return this.notifications
      .createQueryBuilder('notification')
      .innerJoin(
        Appointment,
        'appointment',
        'appointment.id = notification.appointmentId',
      )
      .where('notification.status = :pending', {
        pending: NotificationStatus.Pending,
      })
      .andWhere('notification.scheduledAt <= :now', { now })
      .andWhere('appointment.status = :confirmed', {
        confirmed: AppointmentStatus.Confirmed,
      })
      .orderBy('notification.scheduledAt', 'ASC')
      .limit(limit)
      .getMany();
  }
}
```

The alternative to the shape-normalising two lines is to wrap the `UPDATE` in a
CTE (`WITH updated AS (UPDATE ... RETURNING id) SELECT id FROM updated`) so the
driver sees a `SELECT`. Same atomicity, one fewer conditional — but the plain
`UPDATE ... RETURNING` is the statement the design documents describe, and it is
the one worth being able to read aloud in an interview.

- [ ] **Step 4: Create the module**

Create `src/notifications/notifications.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Appointment } from '../appointments/appointment.entity';
import { Notification } from './notification.entity';
import { NotificationsRepository } from './notifications.repository';

@Module({
  // Appointment is registered here too because findDuePending joins it. It is
  // an entity-level dependency only; this module never imports
  // AppointmentsModule.
  imports: [TypeOrmModule.forFeature([Notification, Appointment])],
  providers: [NotificationsRepository],
  exports: [NotificationsRepository],
})
export class NotificationsModule {}
```

- [ ] **Step 5: Register the module in the API**

Modify `src/app.module.ts` — add `NotificationsModule` to `imports`:

```ts
import { Module } from '@nestjs/common';
import { ClockModule } from './common/clock/clock.module';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { NotificationsModule } from './notifications/notifications.module';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    ClockModule,
    HealthModule,
    NotificationsModule,
  ],
})
export class AppModule {}
```

Keep any modules Plans 2–5 already added; this step only appends
`NotificationsModule`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx jest --config test/jest-e2e.json test/notifications-repository.e2e-spec.ts`
Expected: PASS — 8 tests.

- [ ] **Step 7: Commit**

```bash
git add src/notifications src/app.module.ts test/notifications-repository.e2e-spec.ts
git commit -m "feat(notifications): add repository with atomic pending-to-sent transition"
```

---

## Task 3: BullMQ wiring, queue constants and `JobsService`

One module owns the Redis connection and the three queues; one service is the
only place in the codebase that calls `queue.add`.

**Files:**
- Create: `src/jobs/queue.constants.ts`
- Create: `src/jobs/jobs.service.ts`
- Create: `src/jobs/jobs.module.ts`
- Create: `test/redis-helper.ts`
- Test: `src/jobs/queue.constants.spec.ts`
- Test: `src/jobs/jobs.service.spec.ts`
- Test: `test/reminder-queue.e2e-spec.ts`
- Modify: `package.json`, `.env.example`, `test/setup-db.ts`,
  `test/jest-e2e.json`, `src/app.module.ts`

**Interfaces:**
- Consumes: `Clock` (Plan 1), `ConfigService` with `REDIS_URL` (Plan 1).
- Produces: every symbol in `docs/PLANS/00-interfaces.md` § *Queue Contract
  (Plan 6)* — `QUEUE_REMINDERS`, `QUEUE_WAITING_LIST`, `QUEUE_MAINTENANCE`,
  `JOB_SEND_REMINDER`, `JOB_PROCESS_SLOT`, `JOB_RECONCILE`,
  `SendReminderJobData`, `ProcessSlotJobData`, `processSlotJobId`,
  `sendReminderJobId`, `RECONCILE_EVERY_MS`, `WAITING_LIST_CANDIDATE_LIMIT` —
  plus `RECONCILE_SCHEDULER_ID`, `RECONCILE_BATCH_LIMIT` and
  `sweepReminderJobId`. Also `JobsModule` (exports `BullModule` and
  `JobsService`) and:

```ts
class JobsService {
  scheduleReminder(appointmentId: string, scheduledAt: Date): Promise<void>
  removeReminder(appointmentId: string): Promise<void>
  enqueueDueReminder(appointmentId: string, now: Date): Promise<void>
  enqueueSlotProcessing(doctorId: string, slotStartAt: Date): Promise<void>
}
```

- Test helpers produced, in `test/redis-helper.ts`:

```ts
export const DEFAULT_TEST_REDIS_URL = 'redis://localhost:6379/1';
assertIsolatedRedis(url: string): void
flushTestRedis(): Promise<void>
waitFor(
  predicate: () => Promise<boolean>,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void>
```

**Plan 5 integration point.** `AppointmentsService.book()` calls
`scheduleReminder` after commit. `AppointmentsService.cancel()` calls
`removeReminder` (best effort) and `enqueueSlotProcessing`, both after commit.
`AppointmentsModule` imports `JobsModule` to get them; `JobsModule` imports no
feature module, so there is no cycle.

- [ ] **Step 1: Install dependencies**

```bash
npm install @nestjs/bullmq bullmq ioredis
```

Expected: `bullmq` at `^5.34.0` or newer in `package.json`.
`queue.upsertJobScheduler()` (Task 6) needs 5.16+. `ioredis` is already a
transitive dependency of `bullmq`; it is declared explicitly because
`test/redis-helper.ts` imports it directly.

- [ ] **Step 2: Write the failing constants test**

Create `src/jobs/queue.constants.spec.ts`:

```ts
import {
  RECONCILE_EVERY_MS,
  processSlotJobId,
  sendReminderJobId,
  sweepReminderJobId,
} from './queue.constants';

describe('job ids', () => {
  it('derives the same reminder id for the same appointment', () => {
    const id = sendReminderJobId('11111111-1111-1111-1111-111111111111');

    expect(id).toBe('reminder:11111111-1111-1111-1111-111111111111');
    expect(sendReminderJobId('11111111-1111-1111-1111-111111111111')).toBe(id);
  });

  it('derives the same slot id for the same doctor and slot', () => {
    const slotStartAt = new Date('2026-10-01T09:00:00.000Z');

    expect(processSlotJobId('doc-1', slotStartAt)).toBe(
      'waitlist:doc-1:2026-10-01T09:00:00.000Z',
    );
  });

  it('gives two sweeps in the same minute the same reminder id', () => {
    const first = new Date('2026-10-01T09:00:01.000Z');
    const second = new Date('2026-10-01T09:00:59.000Z');

    expect(sweepReminderJobId('appt-1', first)).toBe(
      sweepReminderJobId('appt-1', second),
    );
  });

  it('gives the next sweep a different reminder id', () => {
    const first = new Date('2026-10-01T09:00:00.000Z');
    const next = new Date(first.getTime() + RECONCILE_EVERY_MS);

    expect(sweepReminderJobId('appt-1', next)).not.toBe(
      sweepReminderJobId('appt-1', first),
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest src/jobs/queue.constants.spec.ts`
Expected: FAIL — `Cannot find module './queue.constants'`.

- [ ] **Step 4: Write the queue constants**

Create `src/jobs/queue.constants.ts`:

```ts
export const QUEUE_REMINDERS = 'reminders';
export const QUEUE_WAITING_LIST = 'waiting-list';
export const QUEUE_MAINTENANCE = 'maintenance';

export const JOB_SEND_REMINDER = 'send-reminder';
export const JOB_PROCESS_SLOT = 'process-slot';
export const JOB_RECONCILE = 'reconcile';

export interface SendReminderJobData {
  appointmentId: string;
}

export interface ProcessSlotJobData {
  doctorId: string;
  slotStartAtIso: string;
}

/** Deterministic id so duplicate enqueues for the same slot collapse into one. */
export function processSlotJobId(doctorId: string, slotStartAt: Date): string {
  return `waitlist:${doctorId}:${slotStartAt.toISOString()}`;
}

export function sendReminderJobId(appointmentId: string): string {
  return `reminder:${appointmentId}`;
}

export const RECONCILE_EVERY_MS = 60_000;
export const WAITING_LIST_CANDIDATE_LIMIT = 10;

/** BullMQ job-scheduler key for the repeatable sweeper. Upserted, so re-registering is safe. */
export const RECONCILE_SCHEDULER_ID = 'reconcile-sweeper';

/** How many due notifications one sweep pass will re-enqueue. */
export const RECONCILE_BATCH_LIMIT = 100;

/**
 * Job id used when the *sweeper* re-enqueues a reminder.
 *
 * Deliberately not sendReminderJobId(): BullMQ ignores `add` for a job id that
 * already exists, and the original id may still be held by a job sitting in the
 * failed set. Bucketing by sweep interval keeps two replicas sweeping the same
 * minute from creating two jobs, while never being permanently blocked.
 * Duplicate *delivery* is prevented by markSentIfPending, not by this id.
 */
export function sweepReminderJobId(appointmentId: string, now: Date): string {
  const bucket = Math.floor(now.getTime() / RECONCILE_EVERY_MS);
  return `reminder-sweep:${appointmentId}:${bucket}`;
}
```

Job payloads carry identifiers only, never state. A retry re-reads everything
from PostgreSQL, so it acts on current data rather than on a snapshot taken when
the job was created.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/jobs/queue.constants.spec.ts`
Expected: PASS — 4 tests.

- [ ] **Step 6: Write the failing `JobsService` test**

Create `src/jobs/jobs.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Clock, FixedClock } from '../common/clock/clock';
import { JobsService } from './jobs.service';
import {
  JOB_PROCESS_SLOT,
  JOB_SEND_REMINDER,
  QUEUE_REMINDERS,
  QUEUE_WAITING_LIST,
} from './queue.constants';

const NOW = new Date('2026-10-01T09:00:00.000Z');

describe('JobsService', () => {
  const reminders = { add: jest.fn(), remove: jest.fn() };
  const waitingList = { add: jest.fn() };
  let service: JobsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        JobsService,
        { provide: Clock, useValue: new FixedClock(NOW) },
        { provide: getQueueToken(QUEUE_REMINDERS), useValue: reminders },
        { provide: getQueueToken(QUEUE_WAITING_LIST), useValue: waitingList },
      ],
    }).compile();

    service = moduleRef.get(JobsService);
  });

  it('delays a future reminder by the remaining time', async () => {
    await service.scheduleReminder('appt-1', new Date('2026-10-02T09:00:00.000Z'));

    expect(reminders.add).toHaveBeenCalledWith(
      JOB_SEND_REMINDER,
      { appointmentId: 'appt-1' },
      { jobId: 'reminder:appt-1', delay: 86_400_000 },
    );
  });

  it('fires a reminder scheduled in the past immediately', async () => {
    await service.scheduleReminder('appt-1', new Date('2026-09-30T09:00:00.000Z'));

    expect(reminders.add).toHaveBeenCalledWith(
      JOB_SEND_REMINDER,
      { appointmentId: 'appt-1' },
      { jobId: 'reminder:appt-1', delay: 0 },
    );
  });

  it('never sends a negative delay to BullMQ', async () => {
    await service.scheduleReminder('appt-1', new Date('2020-01-01T00:00:00.000Z'));

    const options = reminders.add.mock.calls[0][2] as { delay: number };
    expect(options.delay).toBe(0);
  });

  it('enqueues slot processing with the deterministic slot id', async () => {
    await service.enqueueSlotProcessing('doc-1', new Date('2026-10-01T11:00:00.000Z'));

    expect(waitingList.add).toHaveBeenCalledWith(
      JOB_PROCESS_SLOT,
      { doctorId: 'doc-1', slotStartAtIso: '2026-10-01T11:00:00.000Z' },
      { jobId: 'waitlist:doc-1:2026-10-01T11:00:00.000Z' },
    );
  });

  it('swallows a failure to remove a reminder job', async () => {
    reminders.remove.mockRejectedValueOnce(new Error('Redis is down'));

    await expect(service.removeReminder('appt-1')).resolves.toBeUndefined();
  });
});
```

Two of these encode business rules, not plumbing. *Reminders scheduled in the
past fire immediately* is `docs/DECISIONS.md` #15: a booking made under 24 hours
out still gets its notification row and its reminder, so the invariant "every
confirmed appointment has exactly one reminder record" holds without a special
case. *Swallowing a removal failure* is the cancellation rule: removal is
best-effort tidiness and must never be the thing that stops a reminder — an
exception here would fail an otherwise successful cancellation.

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx jest src/jobs/jobs.service.spec.ts`
Expected: FAIL — `Cannot find module './jobs.service'`.

- [ ] **Step 8: Implement `JobsService`**

Create `src/jobs/jobs.service.ts`:

```ts
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Clock } from '../common/clock/clock';
import {
  JOB_PROCESS_SLOT,
  JOB_SEND_REMINDER,
  ProcessSlotJobData,
  QUEUE_REMINDERS,
  QUEUE_WAITING_LIST,
  SendReminderJobData,
  processSlotJobId,
  sendReminderJobId,
  sweepReminderJobId,
} from './queue.constants';

/**
 * The only place in the codebase that enqueues a job.
 *
 * Every caller must already have committed its transaction. PostgreSQL and
 * Redis cannot commit together, so enqueueing inside a transaction would let a
 * worker read pre-commit state; see docs/INFRASTRUCTURE/BackgroundJobs.md.
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    @InjectQueue(QUEUE_REMINDERS)
    private readonly reminders: Queue<SendReminderJobData>,
    @InjectQueue(QUEUE_WAITING_LIST)
    private readonly waitingList: Queue<ProcessSlotJobData>,
    private readonly clock: Clock,
  ) {}

  /** Call after the booking transaction commits. */
  async scheduleReminder(appointmentId: string, scheduledAt: Date): Promise<void> {
    // An appointment booked less than REMINDER_LEAD_HOURS out has a
    // scheduled_at in the past. It still gets a reminder; it just fires now.
    const delay = Math.max(0, scheduledAt.getTime() - this.clock.now().getTime());

    await this.reminders.add(
      JOB_SEND_REMINDER,
      { appointmentId },
      { jobId: sendReminderJobId(appointmentId), delay },
    );
  }

  /**
   * Best-effort tidying of the delayed set after a cancellation.
   *
   * Never the guarantee that a cancelled appointment sends no reminder — the
   * worker re-checks appointment status at execution time. Removal can fail
   * because the job is already active, or because Redis is unavailable, and
   * neither may fail the cancellation that just committed.
   */
  async removeReminder(appointmentId: string): Promise<void> {
    try {
      await this.reminders.remove(sendReminderJobId(appointmentId));
    } catch (error) {
      this.logger.warn(
        `Could not remove reminder job for appointment ${appointmentId}: ` +
          `${(error as Error).message}. The worker will skip it on status re-check.`,
      );
    }
  }

  /** Used by the reconciliation sweeper for a reminder whose job was lost. */
  async enqueueDueReminder(appointmentId: string, now: Date): Promise<void> {
    await this.reminders.add(
      JOB_SEND_REMINDER,
      { appointmentId },
      { jobId: sweepReminderJobId(appointmentId, now) },
    );
  }

  /** Call after the cancellation transaction commits. */
  async enqueueSlotProcessing(doctorId: string, slotStartAt: Date): Promise<void> {
    await this.waitingList.add(
      JOB_PROCESS_SLOT,
      { doctorId, slotStartAtIso: slotStartAt.toISOString() },
      { jobId: processSlotJobId(doctorId, slotStartAt) },
    );
  }
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx jest src/jobs/jobs.service.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 10: Create `JobsModule` with retry and backoff defaults**

Create `src/jobs/jobs.module.ts`:

```ts
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobsService } from './jobs.service';
import {
  QUEUE_MAINTENANCE,
  QUEUE_REMINDERS,
  QUEUE_WAITING_LIST,
} from './queue.constants';

/**
 * Redis connection and queue registration.
 *
 * Registering a queue creates a producer only — no worker. That is why both the
 * API and the worker process can import this module, while only the worker
 * imports ProcessorsModule. See docs/DECISIONS.md #13.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: { url: config.getOrThrow<string>('REDIS_URL') },
      }),
    }),
    BullModule.registerQueue(
      {
        name: QUEUE_REMINDERS,
        defaultJobOptions: {
          // A reminder that fails is worth retrying for a while: the usual
          // cause is a transient database or Redis blip, and re-running is
          // safe because markSentIfPending only ever succeeds once.
          attempts: 5,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { age: 3_600, count: 1_000 },
          // Failed jobs are kept for a day so an exhausted retry chain is
          // visible instead of vanishing.
          removeOnFail: { age: 86_400 },
        },
      },
      {
        name: QUEUE_WAITING_LIST,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: { age: 3_600, count: 1_000 },
          removeOnFail: { age: 86_400 },
        },
      },
      {
        name: QUEUE_MAINTENANCE,
        defaultJobOptions: {
          // The sweeper runs again in 60 seconds regardless, so long retry
          // chains would only pile up overlapping passes.
          attempts: 3,
          backoff: { type: 'fixed', delay: 5_000 },
          removeOnComplete: { count: 20 },
          removeOnFail: { count: 50 },
        },
      },
    ),
  ],
  providers: [JobsService],
  exports: [BullModule, JobsService],
})
export class JobsModule {}
```

`removeOnComplete` matters more than it looks. BullMQ ignores `add` for a job id
that already exists, so keeping completed jobs forever would make a deterministic
job id un-reusable. Retries are safe here only because every consumer is
idempotent — a failed job must never produce a duplicate reminder, appointment
or waiting-list assignment.

- [ ] **Step 11: Register `JobsModule` in the API**

Modify `src/app.module.ts` — add `JobsModule` to `imports` alongside
`NotificationsModule`:

```ts
import { JobsModule } from './jobs/jobs.module';

// imports: [..., NotificationsModule, JobsModule]
```

The API needs the queues so `AppointmentsService` can enqueue after commit. It
must **not** import `ProcessorsModule`: scaling the API to two replicas would
otherwise double the worker pool as a side effect.

- [ ] **Step 12: Isolate the test Redis**

Add to `.env.example`:

```text
# Redis database index used by the integration suite. Must not be 0 — the suite
# flushes it between tests, and database 0 holds real delayed reminder jobs.
TEST_REDIS_URL=redis://localhost:6379/1
```

Create `test/redis-helper.ts`:

```ts
import Redis from 'ioredis';

export const DEFAULT_TEST_REDIS_URL = 'redis://localhost:6379/1';

/**
 * Refuses to touch Redis database 0.
 *
 * `docker compose up` puts real delayed reminder jobs in database 0. The
 * integration suite flushes whatever it is pointed at, so pointing it at 0
 * would delete every scheduled reminder on the developer's machine.
 */
export function assertIsolatedRedis(url: string): void {
  const database = new URL(url).pathname.replace('/', '');

  if (database === '' || database === '0') {
    throw new Error(
      `Refusing to run the integration suite against Redis database 0 (${url}). ` +
        `Set TEST_REDIS_URL to a dedicated index, for example ${DEFAULT_TEST_REDIS_URL}`,
    );
  }
}

/** Empties the test Redis database. Call in beforeEach of any queue test. */
export async function flushTestRedis(): Promise<void> {
  const url = process.env.REDIS_URL;

  if (!url) {
    throw new Error('REDIS_URL is not set; test/setup-db.ts should have set it');
  }

  assertIsolatedRedis(url);

  const client = new Redis(url, { maxRetriesPerRequest: null });
  try {
    await client.flushdb();
  } finally {
    await client.quit();
  }
}

/**
 * Polls until the predicate is true.
 *
 * Queue tests cannot assert immediately after enqueueing: a real worker in
 * another event-loop turn has to pick the job up first.
 */
export async function waitFor(
  predicate: () => Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const { timeoutMs = 10_000, intervalMs = 50 } = options;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for the condition`);
}
```

Modify `test/setup-db.ts` — add the Redis redirect inside `globalSetup`, after
the existing `process.env.DATABASE_URL = url;` line:

```ts
import { DEFAULT_TEST_REDIS_URL, assertIsolatedRedis } from './redis-helper';

// ... inside globalSetup, after process.env.DATABASE_URL = url;

const redisUrl = process.env.TEST_REDIS_URL ?? DEFAULT_TEST_REDIS_URL;
assertIsolatedRedis(redisUrl);
process.env.REDIS_URL = redisUrl;
```

Same trick Plan 1 uses for `DATABASE_URL`: `globalSetup` runs before Jest forks
its workers, so the reassignment is inherited by every test file.

Modify `test/jest-e2e.json` — add a longer timeout, because the queue tests wait
on a real worker:

```json
{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": "..",
  "testEnvironment": "node",
  "testRegex": ".e2e-spec.ts$",
  "transform": {
    "^.+\\.(t|j)s$": "ts-jest"
  },
  "globalSetup": "<rootDir>/test/setup-db.ts",
  "maxWorkers": 1,
  "testTimeout": 30000
}
```

- [ ] **Step 13: Write the queue round-trip test**

Create `test/reminder-queue.e2e-spec.ts`:

```ts
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { ClockModule } from '../src/common/clock/clock.module';
import { AppConfigModule } from '../src/config/config.module';
import { JobsModule } from '../src/jobs/jobs.module';
import { JobsService } from '../src/jobs/jobs.service';
import { QUEUE_REMINDERS, QUEUE_WAITING_LIST } from '../src/jobs/queue.constants';
import { flushTestRedis } from './redis-helper';

describe('enqueueing jobs', () => {
  let moduleRef: TestingModule;
  let jobs: JobsService;
  let reminders: Queue;
  let waitingList: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, ClockModule, JobsModule],
    }).compile();
    await moduleRef.init();

    jobs = moduleRef.get(JobsService);
    reminders = moduleRef.get<Queue>(getQueueToken(QUEUE_REMINDERS));
    waitingList = moduleRef.get<Queue>(getQueueToken(QUEUE_WAITING_LIST));
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await flushTestRedis();
  });

  it('puts a future reminder in the delayed set', async () => {
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000);

    await jobs.scheduleReminder('11111111-1111-1111-1111-111111111111', scheduledAt);

    await expect(reminders.getDelayedCount()).resolves.toBe(1);
    await expect(reminders.getWaitingCount()).resolves.toBe(0);
  });

  it('puts a past-due reminder straight into the waiting set', async () => {
    const scheduledAt = new Date(Date.now() - 60 * 60 * 1000);

    await jobs.scheduleReminder('11111111-1111-1111-1111-111111111111', scheduledAt);

    await expect(reminders.getWaitingCount()).resolves.toBe(1);
    await expect(reminders.getDelayedCount()).resolves.toBe(0);
  });

  it('collapses two enqueues for the same appointment into one job', async () => {
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000);
    const appointmentId = '11111111-1111-1111-1111-111111111111';

    await jobs.scheduleReminder(appointmentId, scheduledAt);
    await jobs.scheduleReminder(appointmentId, scheduledAt);

    await expect(reminders.getDelayedCount()).resolves.toBe(1);
  });

  it('collapses two enqueues for the same slot into one job', async () => {
    const slotStartAt = new Date('2026-10-01T09:00:00.000Z');

    await jobs.enqueueSlotProcessing('doc-1', slotStartAt);
    await jobs.enqueueSlotProcessing('doc-1', slotStartAt);

    const queued = await waitingList.getJobs(['waiting', 'delayed']);
    expect(queued).toHaveLength(1);
    expect(queued[0].id).toBe('waitlist:doc-1:2026-10-01T09:00:00.000Z');
  });

  it('removing a reminder that does not exist is not an error', async () => {
    await expect(jobs.removeReminder('does-not-exist')).resolves.toBeUndefined();
  });
});
```

This file is the proof that the two design claims are real rather than
intentions: a past-due reminder is *waiting*, not *delayed*, and a duplicate
enqueue produces one job because the id is derived rather than random.

- [ ] **Step 14: Run the queue test**

```bash
docker compose up -d redis
npx jest --config test/jest-e2e.json test/reminder-queue.e2e-spec.ts
```

Expected: PASS — 5 tests.

- [ ] **Step 15: Verify the isolation guard actually refuses**

```bash
TEST_REDIS_URL=redis://localhost:6379 npx jest --config test/jest-e2e.json test/reminder-queue.e2e-spec.ts
```

Expected: FAIL during global setup with `Refusing to run the integration suite
against Redis database 0`. On PowerShell:
`$env:TEST_REDIS_URL='redis://localhost:6379'; npx jest --config test/jest-e2e.json test/reminder-queue.e2e-spec.ts; Remove-Item Env:TEST_REDIS_URL`.

A safety guard that has never been seen to fire is not known to work.

- [ ] **Step 16: Commit**

```bash
git add package.json package-lock.json .env.example src/jobs src/app.module.ts test/redis-helper.ts test/setup-db.ts test/jest-e2e.json test/reminder-queue.e2e-spec.ts
git commit -m "feat(jobs): wire BullMQ queues with retry defaults and post-commit enqueueing"
```

---

## Task 4: The appointment reminder processor

**Files:**
- Create: `src/jobs/appointment-reminder.processor.ts`
- Create: `src/jobs/processors.module.ts`
- Test: `test/appointment-reminder.e2e-spec.ts`

**Interfaces:**
- Consumes: `NotificationsRepository` (Task 2), `SendReminderJobData`,
  `QUEUE_REMINDERS`, `JOB_SEND_REMINDER`, `JobsModule` (Task 3), the
  `Appointment` entity and `AppointmentStatus` (Plan 5).
- Produces: `AppointmentReminderProcessor` with
  `process(job: Job<SendReminderJobData>): Promise<void>`; `ProcessorsModule`,
  which is imported **only** by the worker process.

**What Plan 7 adds to `ProcessorsModule`:** `WaitingListModule` and
`AppointmentsModule` to `imports`, `WaitingListProcessor` to `providers`, and a
replacement binding for the `WaitingListReconciler` token introduced in Task 6.
Nothing else in this plan changes.

- [ ] **Step 1: Write the failing processor test**

Create `test/appointment-reminder.e2e-spec.ts`:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { DataSource } from 'typeorm';
import { Appointment } from '../src/appointments/appointment.entity';
import { AppConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/database/database.module';
import { AppointmentReminderProcessor } from '../src/jobs/appointment-reminder.processor';
import {
  JOB_SEND_REMINDER,
  SendReminderJobData,
} from '../src/jobs/queue.constants';
import { NotificationsModule } from '../src/notifications/notifications.module';
import {
  cancelAppointment,
  insertPendingReminder,
  resetJobTables,
  seedConfirmedAppointment,
} from './job-fixtures';

const START_AT = new Date('2026-10-01T09:00:00.000Z');
const END_AT = new Date('2026-10-01T09:30:00.000Z');
const SCHEDULED_AT = new Date('2026-09-30T09:00:00.000Z');

/**
 * A Job object is only a data carrier here. The processor is invoked directly,
 * so no Redis and no worker are involved: this suite tests the decision the
 * worker makes, not the delivery mechanism.
 */
function reminderJob(appointmentId: string): Job<SendReminderJobData> {
  return {
    id: 'test-job',
    name: JOB_SEND_REMINDER,
    data: { appointmentId },
    attemptsMade: 0,
  } as Job<SendReminderJobData>;
}

async function readNotification(
  dataSource: DataSource,
  appointmentId: string,
): Promise<{ status: string; sent_at: Date | null } | undefined> {
  const rows: Array<{ status: string; sent_at: Date | null }> = await dataSource.query(
    'SELECT status, sent_at FROM notifications WHERE appointment_id = $1',
    [appointmentId],
  );
  return rows[0];
}

describe('AppointmentReminderProcessor', () => {
  let moduleRef: TestingModule;
  let processor: AppointmentReminderProcessor;
  let dataSource: DataSource;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        DatabaseModule,
        NotificationsModule,
        TypeOrmModule.forFeature([Appointment]),
      ],
      providers: [AppointmentReminderProcessor],
    }).compile();

    processor = moduleRef.get(AppointmentReminderProcessor);
    dataSource = moduleRef.get(DataSource);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await resetJobTables(dataSource);
  });

  it('sends exactly one notification for a confirmed appointment', async () => {
    const slot = await seedConfirmedAppointment(dataSource, {
      startAt: START_AT,
      endAt: END_AT,
    });
    await insertPendingReminder(dataSource, {
      appointmentId: slot.appointmentId,
      patientId: slot.patientId,
      scheduledAt: SCHEDULED_AT,
    });

    await processor.process(reminderJob(slot.appointmentId));

    const notification = await readNotification(dataSource, slot.appointmentId);
    expect(notification?.status).toBe('SENT');
    expect(notification?.sent_at).not.toBeNull();

    const [{ count }]: Array<{ count: string }> = await dataSource.query(
      'SELECT count(*)::text AS count FROM notifications',
    );
    expect(count).toBe('1');
  });

  it('a retry does not send a second time', async () => {
    const slot = await seedConfirmedAppointment(dataSource, {
      startAt: START_AT,
      endAt: END_AT,
    });
    await insertPendingReminder(dataSource, {
      appointmentId: slot.appointmentId,
      patientId: slot.patientId,
      scheduledAt: SCHEDULED_AT,
    });

    await processor.process(reminderJob(slot.appointmentId));
    const afterFirst = await readNotification(dataSource, slot.appointmentId);

    await expect(
      processor.process(reminderJob(slot.appointmentId)),
    ).resolves.toBeUndefined();

    const afterSecond = await readNotification(dataSource, slot.appointmentId);
    expect(afterSecond?.sent_at).toEqual(afterFirst?.sent_at);

    const [{ count }]: Array<{ count: string }> = await dataSource.query(
      'SELECT count(*)::text AS count FROM notifications',
    );
    expect(count).toBe('1');
  });

  it('does not send a reminder for a cancelled appointment', async () => {
    const slot = await seedConfirmedAppointment(dataSource, {
      startAt: START_AT,
      endAt: END_AT,
    });
    await insertPendingReminder(dataSource, {
      appointmentId: slot.appointmentId,
      patientId: slot.patientId,
      scheduledAt: SCHEDULED_AT,
    });
    await cancelAppointment(dataSource, slot.appointmentId);

    await processor.process(reminderJob(slot.appointmentId));

    const notification = await readNotification(dataSource, slot.appointmentId);
    expect(notification?.status).toBe('PENDING');
    expect(notification?.sent_at).toBeNull();
  });

  it('exits successfully when the appointment does not exist', async () => {
    await expect(
      processor.process(reminderJob('00000000-0000-0000-0000-000000000000')),
    ).resolves.toBeUndefined();
  });

  it('exits successfully when there is no notification row', async () => {
    const slot = await seedConfirmedAppointment(dataSource, {
      startAt: START_AT,
      endAt: END_AT,
    });

    await expect(
      processor.process(reminderJob(slot.appointmentId)),
    ).resolves.toBeUndefined();
  });

  it('lets exactly one of five concurrent runs send the reminder', async () => {
    const slot = await seedConfirmedAppointment(dataSource, {
      startAt: START_AT,
      endAt: END_AT,
    });
    await insertPendingReminder(dataSource, {
      appointmentId: slot.appointmentId,
      patientId: slot.patientId,
      scheduledAt: SCHEDULED_AT,
    });

    await Promise.all(
      Array.from({ length: 5 }, () => processor.process(reminderJob(slot.appointmentId))),
    );

    const [{ count }]: Array<{ count: string }> = await dataSource.query(
      "SELECT count(*)::text AS count FROM notifications WHERE status = 'SENT'",
    );
    expect(count).toBe('1');
  });
});
```

`does not send a reminder for a cancelled appointment` is the test that proves
job removal is not load-bearing: the job is executed *directly*, exactly as if
removal had failed or the worker had already dequeued it, and nothing is sent.
That is the guarantee, and it lives in the worker's status re-check.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest --config test/jest-e2e.json test/appointment-reminder.e2e-spec.ts`
Expected: FAIL — `Cannot find module '../src/jobs/appointment-reminder.processor'`.

- [ ] **Step 3: Implement the processor**

Create `src/jobs/appointment-reminder.processor.ts`:

```ts
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { Appointment } from '../appointments/appointment.entity';
import { AppointmentStatus } from '../common/enums/appointment-status.enum';
import { NotificationType } from '../common/enums/notification-type.enum';
import { NotificationsRepository } from '../notifications/notifications.repository';
import {
  QUEUE_REMINDERS,
  SendReminderJobData,
} from './queue.constants';

@Processor(QUEUE_REMINDERS, { concurrency: 5 })
export class AppointmentReminderProcessor extends WorkerHost {
  private readonly logger = new Logger(AppointmentReminderProcessor.name);

  constructor(
    @InjectRepository(Appointment)
    private readonly appointments: Repository<Appointment>,
    private readonly notifications: NotificationsRepository,
  ) {
    super();
  }

  async process(job: Job<SendReminderJobData>): Promise<void> {
    const { appointmentId } = job.data;

    // Step 1: re-derive from the database. The payload carries an id only, so
    // a retry hours later still acts on current state.
    const appointment = await this.appointments.findOne({
      where: { id: appointmentId },
    });

    // Step 2: a cancelled (or deleted) appointment sends nothing. This — not
    // removing the BullMQ job — is what guarantees it.
    if (!appointment || appointment.status !== AppointmentStatus.Confirmed) {
      this.logger.log(
        `Reminder skipped: appointment ${appointmentId} is not CONFIRMED`,
      );
      return;
    }

    // Step 3: claim the send with one conditional update. Zero rows means
    // another worker already sent it, or there is nothing to send.
    const claimed = await this.notifications.markSentIfPending(
      appointmentId,
      NotificationType.Reminder,
    );

    if (!claimed) {
      this.logger.log(
        `Reminder for appointment ${appointmentId} was already sent; nothing to do`,
      );
      return;
    }

    // Step 4: "send" it. The task requires no real email or SMS; the
    // notifications row is what makes the behaviour observable.
    this.logger.log(
      `REMINDER sent: appointment ${appointmentId} for patient ` +
        `${appointment.patientId} starts at ${appointment.startAt.toISOString()}`,
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<SendReminderJobData>, error: Error): void {
    this.logger.error(
      `Reminder job ${job.id} failed on attempt ${job.attemptsMade}: ${error.message}`,
    );
  }
}
```

The order of steps 2 and 3 is deliberate. Claiming first and then checking
status would mark a cancelled appointment's reminder as SENT, permanently losing
the ability to tell it apart from one that was actually delivered.

`@Processor` only attaches metadata; the BullMQ worker is created by
`@nestjs/bullmq`'s explorer, which exists only where `BullModule` is imported.
That is why the test above can provide this class on its own and invoke
`process()` with no Redis running.

- [ ] **Step 4: Create `ProcessorsModule`**

Create `src/jobs/processors.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Appointment } from '../appointments/appointment.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { AppointmentReminderProcessor } from './appointment-reminder.processor';
import { JobsModule } from './jobs.module';

/**
 * The BullMQ processors. Imported by src/worker.module.ts only.
 *
 * If this module were imported by AppModule, scaling the API to two replicas
 * would double the worker pool as a side effect — a change to request capacity
 * quietly changing job concurrency. See docs/DECISIONS.md #13.
 */
@Module({
  imports: [
    JobsModule,
    NotificationsModule,
    // Entity-level dependency only. Plan 7 adds AppointmentsModule here for
    // AppointmentsService.createFromWaitingList.
    TypeOrmModule.forFeature([Appointment]),
  ],
  providers: [AppointmentReminderProcessor],
})
export class ProcessorsModule {}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest --config test/jest-e2e.json test/appointment-reminder.e2e-spec.ts`
Expected: PASS — 6 tests.

- [ ] **Step 6: Add the real-retry test**

Add these imports to the top of `test/appointment-reminder.e2e-spec.ts`, merging
the `@nestjs/typeorm` and `typeorm` lines into the ones already there so each
module is imported once:

```ts
import { getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { ClockModule } from '../src/common/clock/clock.module';
import { NotificationType } from '../src/common/enums/notification-type.enum';
import { JobsModule } from '../src/jobs/jobs.module';
import { JOB_SEND_REMINDER, QUEUE_REMINDERS } from '../src/jobs/queue.constants';
import { Notification } from '../src/notifications/notification.entity';
import { NotificationsRepository } from '../src/notifications/notifications.repository';
import { flushTestRedis, waitFor } from './redis-helper';
```

Then append this describe block at the end of the file:

```ts
describe('reminder delivery through a real BullMQ worker', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let queue: Queue;

  beforeAll(async () => {
    // JobsModule brings BullModule, whose explorer discovers any provider
    // carrying @Processor metadata — including one declared right here. So a
    // real worker runs, without pulling in ProcessorsModule and with it the
    // repeatable sweeper, which would enqueue jobs behind this test's back.
    moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        DatabaseModule,
        ClockModule,
        JobsModule,
        NotificationsModule,
        TypeOrmModule.forFeature([Appointment]),
      ],
      providers: [AppointmentReminderProcessor],
    })
      // Fails the first markSentIfPending call, then delegates to the real one.
      // This is the "worker crashed mid-job" case, driven by real BullMQ retry.
      .overrideProvider(NotificationsRepository)
      .useFactory({
        inject: [getRepositoryToken(Notification)],
        factory: (repository: Repository<Notification>) => {
          const real = new NotificationsRepository(repository);
          let failuresLeft = 1;

          return {
            createPending: real.createPending.bind(real),
            findDuePending: real.findDuePending.bind(real),
            markSentIfPending: async (
              appointmentId: string,
              type: NotificationType,
            ): Promise<boolean> => {
              if (failuresLeft > 0) {
                failuresLeft -= 1;
                throw new Error('simulated database blip');
              }
              return real.markSentIfPending(appointmentId, type);
            },
          };
        },
      })
      .compile();

    await moduleRef.init();
    dataSource = moduleRef.get(DataSource);
    queue = moduleRef.get<Queue>(getQueueToken(QUEUE_REMINDERS));
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await flushTestRedis();
    await resetJobTables(dataSource);
  });

  it('retries a failed job and still sends exactly one reminder', async () => {
    const slot = await seedConfirmedAppointment(dataSource, {
      startAt: START_AT,
      endAt: END_AT,
    });
    await insertPendingReminder(dataSource, {
      appointmentId: slot.appointmentId,
      patientId: slot.patientId,
      scheduledAt: SCHEDULED_AT,
    });

    // Per-job options override the queue defaults, so the test does not have
    // to wait out the 5-second exponential backoff.
    await queue.add(
      JOB_SEND_REMINDER,
      { appointmentId: slot.appointmentId },
      { attempts: 3, backoff: { type: 'fixed', delay: 100 } },
    );

    await waitFor(async () => {
      const [{ count }]: Array<{ count: string }> = await dataSource.query(
        "SELECT count(*)::text AS count FROM notifications WHERE status = 'SENT'",
      );
      return count === '1';
    });

    const [{ count }]: Array<{ count: string }> = await dataSource.query(
      'SELECT count(*)::text AS count FROM notifications',
    );
    expect(count).toBe('1');
    await expect(queue.getFailedCount()).resolves.toBe(0);
  });
});
```

- [ ] **Step 7: Run the whole reminder suite**

```bash
docker compose up -d postgres redis
docker compose --profile test up -d postgres-test
npx jest --config test/jest-e2e.json test/appointment-reminder.e2e-spec.ts
```

Expected: PASS — 7 tests. `getFailedCount()` is 0 because the job succeeded on
its second attempt; the important assertion is that one reminder exists, not
two.

- [ ] **Step 8: Commit**

```bash
git add src/jobs/appointment-reminder.processor.ts src/jobs/processors.module.ts test/appointment-reminder.e2e-spec.ts
git commit -m "feat(jobs): add appointment reminder processor with status re-check"
```

---

## Task 5: The `worker` process and container

**Files:**
- Create: `src/worker.module.ts`
- Create: `src/worker.ts`
- Modify: `package.json` (scripts)
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: `AppConfigModule`, `DatabaseModule`, `ClockModule` (Plan 1);
  `ProcessorsModule` (Task 4); the `runtime` Dockerfile target (Plan 1).
- Produces: an entrypoint `dist/worker.js`; npm scripts `start:worker` and
  `start:worker:dev`; a `worker` service in `docker-compose.yml` built from the
  same image as `api` with `command: ['node', 'dist/worker']`.

- [ ] **Step 1: Create the worker root module**

Create `src/worker.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ClockModule } from './common/clock/clock.module';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { ProcessorsModule } from './jobs/processors.module';

/**
 * Root module of the worker process.
 *
 * Same codebase as the API, different composition: no controllers, no
 * ValidationPipe, no HTTP server — and this is the only module tree that
 * includes ProcessorsModule.
 */
@Module({
  imports: [AppConfigModule, DatabaseModule, ClockModule, ProcessorsModule],
})
export class WorkerModule {}
```

- [ ] **Step 2: Create the worker bootstrap**

Create `src/worker.ts`:

```ts
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  // createApplicationContext, not create(): the worker listens on no port and
  // must not expose an HTTP surface.
  const app = await NestFactory.createApplicationContext(WorkerModule);

  // On SIGTERM, Nest calls onModuleDestroy on @nestjs/bullmq's providers, which
  // closes the workers. Without this, `docker compose stop` kills the process
  // mid-job; the job would be retried and is safe to retry, but finishing the
  // current one is better than relying on that.
  app.enableShutdownHooks();

  new Logger('Worker').log(
    'Worker started: reminders, waiting-list and maintenance queues',
  );
}

void bootstrap();
```

- [ ] **Step 3: Add the worker scripts**

Add to `"scripts"` in `package.json`:

```json
"start:worker": "nest start --entryFile worker",
"start:worker:dev": "nest start --watch --entryFile worker"
```

`nest build` already emits `dist/worker.js` because the file lives under `src/`;
no Dockerfile change is needed.

- [ ] **Step 4: Verify the worker starts on the host**

```bash
docker compose up -d postgres redis
npm run start:worker
```

Expected: `Worker started: reminders, waiting-list and maintenance queues`, no
`Nest application successfully started` line about a port, and the process stays
alive. Stop it with Ctrl+C.

- [ ] **Step 5: Add the `worker` service to `docker-compose.yml`**

Insert after the `api` service, before the `volumes:` block:

```yaml
  worker:
    build:
      context: .
      target: runtime
    # Same image as `api`; only the command differs.
    command: ['node', 'dist/worker']
    environment:
      NODE_ENV: production
      DATABASE_URL: postgres://clinic:clinic@postgres:5432/clinic
      REDIS_URL: redis://redis:6379
      JWT_SECRET: ${JWT_SECRET}
      JWT_EXPIRES_IN: ${JWT_EXPIRES_IN}
      CLINIC_TZ: ${CLINIC_TZ}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    restart: unless-stopped
```

The worker carries `JWT_SECRET` even though it never issues a token, because
both bootstraps share one validated environment schema. Two schemas would be
the alternative, and a second place for configuration to drift is worse than one
unused variable.

One replica, deliberately. `api` scales for the concurrency proof; job capacity
and HTTP capacity are different problems. `docs/DECISIONS.md` #13.

- [ ] **Step 6: Bring up the full stack and verify the worker is running**

```bash
docker compose up --build -d
docker compose ps
docker compose logs worker
```

Expected: `worker` shows `running`; its logs contain
`Worker started: reminders, waiting-list and maintenance queues`. `migrate`
shows `exited (0)`.

- [ ] **Step 7: Verify the API is not processing jobs**

```bash
docker compose logs api | Select-String "AppointmentReminderProcessor"
```

Expected: no output. On a POSIX shell use
`docker compose logs api | grep AppointmentReminderProcessor`. If the API logs
processor lines, `ProcessorsModule` has leaked into `AppModule` and both
replicas are now workers.

- [ ] **Step 8: Verify what a Redis restart does and does not lose**

```bash
docker compose exec redis redis-cli --scan --pattern 'bull:reminders:*' | Measure-Object -Line
docker compose restart redis
docker compose exec redis redis-cli --scan --pattern 'bull:reminders:*' | Measure-Object -Line
docker compose exec postgres psql -U clinic -d clinic -c "SELECT status, scheduled_at FROM notifications WHERE type = 'REMINDER' ORDER BY scheduled_at LIMIT 5;"
```

Expected, provided at least one appointment has been booked: a non-zero count
before, **zero** after, and the `notifications` rows still `PENDING` with their
`scheduled_at` intact. Redis carries no persistence by decision
(`docs/DECISIONS.md` #14), so the restart takes the timer and leaves the record.

Nothing re-sends those reminders yet; the sweeper that does is Task 6. Run the
`notifications` query again after Task 6's end-to-end check to watch a due row
reach `SENT` without its delayed job ever coming back. That is the recovery path
this plan is built around, and it is the more interesting thing to show in the
recording.

- [ ] **Step 9: Commit**

```bash
git add src/worker.ts src/worker.module.ts package.json docker-compose.yml
git commit -m "feat(jobs): run BullMQ processors in a separate worker service"
```

---

## Task 6: The reconciliation sweeper

The recovery story for the commit/enqueue gap, for a lost Redis, and for
waiting-list expiry. Repeatable, every 60 seconds, safe to run twice and safe to
run on two replicas at once.

**Files:**
- Create: `src/jobs/waiting-list-reconciler.ts`
- Create: `src/jobs/reconciliation.processor.ts`
- Create: `src/jobs/reconcile.scheduler.ts`
- Modify: `src/jobs/processors.module.ts`
- Test: `test/reconciliation.e2e-spec.ts`

**Interfaces:**
- Consumes: `NotificationsRepository.findDuePending` (Task 2), `JobsService`
  (Task 3), `Clock` (Plan 1), `RECONCILE_EVERY_MS`,
  `RECONCILE_BATCH_LIMIT`, `RECONCILE_SCHEDULER_ID`, `JOB_RECONCILE`,
  `QUEUE_MAINTENANCE` (Task 3).
- Produces:

```ts
// src/jobs/waiting-list-reconciler.ts
export interface StrandedSlot {
  doctorId: string;
  slotStartAt: Date;
}

export abstract class WaitingListReconciler {
  /** CANCELLED appointments whose slot still has WAITING entries. */
  abstract findStrandedSlots(now: Date, limit: number): Promise<StrandedSlot[]>;
  /** Marks entries EXPIRED where expiresAt or slotStartAt has passed. Returns the count. */
  abstract expireStale(now: Date): Promise<number>;
}

export class NoWaitingListReconciler extends WaitingListReconciler { /* [] and 0 */ }

// src/jobs/reconciliation.processor.ts
export interface ReconciliationSummary {
  strandedSlotsEnqueued: number;
  dueRemindersEnqueued: number;
  waitingEntriesExpired: number;
}
export class ReconciliationProcessor extends WorkerHost {
  process(): Promise<ReconciliationSummary>;
}

// src/jobs/reconcile.scheduler.ts
export class ReconcileScheduler implements OnApplicationBootstrap {}
```

**What Plan 7 must fill in.** Two of the sweeper's three passes read the
`waiting_list` table, which does not exist until Plan 7. Both are isolated
behind the `WaitingListReconciler` abstract class. Plan 6 binds it to
`NoWaitingListReconciler`, which returns `[]` and `0`; the sweeper's third pass
therefore does nothing and its first pass finds nothing, while both code paths
are real, exercised and tested against a stub.

Plan 7 replaces exactly one line in `ProcessorsModule`:

```ts
{ provide: WaitingListReconciler, useClass: WaitingListReconcilerAdapter }
```

where `WaitingListReconcilerAdapter` implements `findStrandedSlots` by calling
`WaitingListRepository.findSlotsWithWaiters` — "is this slot free?" means no
overlapping CONFIRMED appointment, not "does a CANCELLED row still exist". A
join on `appointments.status = 'CANCELLED'` would keep matching after someone
else rebooked the slot, and the sweeper would enqueue a no-op forever.

and delegates `expireStale` to `WaitingListRepository.expireStale(now)`. Plan 6
does **not** create the `waiting_list` table, entity or query.

- [ ] **Step 1: Write the reconciler port**

Create `src/jobs/waiting-list-reconciler.ts`:

```ts
import { Injectable } from '@nestjs/common';

export interface StrandedSlot {
  doctorId: string;
  slotStartAt: Date;
}

/**
 * The two sweeper passes that need the waiting_list table.
 *
 * The table arrives in Plan 7. Keeping these reads behind one small abstract
 * class lets the sweeper be built, tested and shipped now, and lets Plan 7
 * enable it by swapping one provider binding.
 */
export abstract class WaitingListReconciler {
  /**
   * Slots whose appointment is CANCELLED but which still have WAITING entries.
   * These are the slots whose waiting-list job was lost, or never enqueued
   * because the process died between COMMIT and queue.add.
   */
  abstract findStrandedSlots(now: Date, limit: number): Promise<StrandedSlot[]>;

  /**
   * Marks entries EXPIRED where expires_at or slot_start_at has passed.
   * Returns how many were expired.
   */
  abstract expireStale(now: Date): Promise<number>;
}

/** Bound until Plan 7 creates the waiting_list table. */
@Injectable()
export class NoWaitingListReconciler extends WaitingListReconciler {
  async findStrandedSlots(): Promise<StrandedSlot[]> {
    return [];
  }

  async expireStale(): Promise<number> {
    return 0;
  }
}
```

- [ ] **Step 2: Write the failing sweeper test**

Create `test/reconciliation.e2e-spec.ts`:

```ts
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { Clock, FixedClock } from '../src/common/clock/clock';
import { ClockModule } from '../src/common/clock/clock.module';
import { AppConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/database/database.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Appointment } from '../src/appointments/appointment.entity';
import { AppointmentReminderProcessor } from '../src/jobs/appointment-reminder.processor';
import { JobsModule } from '../src/jobs/jobs.module';
import { ReconciliationProcessor } from '../src/jobs/reconciliation.processor';
import { QUEUE_REMINDERS, QUEUE_WAITING_LIST } from '../src/jobs/queue.constants';
import {
  StrandedSlot,
  WaitingListReconciler,
} from '../src/jobs/waiting-list-reconciler';
import { NotificationsModule } from '../src/notifications/notifications.module';
import {
  cancelAppointment,
  insertPendingReminder,
  resetJobTables,
  seedConfirmedAppointment,
} from './job-fixtures';
import { flushTestRedis, waitFor } from './redis-helper';

const NOW = new Date('2026-09-30T10:00:00.000Z');
const START_AT = new Date('2026-10-01T09:00:00.000Z');
const END_AT = new Date('2026-10-01T09:30:00.000Z');
const DUE_AT = new Date('2026-09-30T09:00:00.000Z');

/** Stands in for Plan 7's reconciler so both sweeper passes are exercised now. */
class StubWaitingListReconciler extends WaitingListReconciler {
  stranded: StrandedSlot[] = [];
  expired = 0;

  async findStrandedSlots(): Promise<StrandedSlot[]> {
    return this.stranded;
  }

  async expireStale(): Promise<number> {
    return this.expired;
  }
}

describe('ReconciliationProcessor', () => {
  let moduleRef: TestingModule;
  let processor: ReconciliationProcessor;
  let dataSource: DataSource;
  let reminders: Queue;
  let waitingList: Queue;
  const reconciler = new StubWaitingListReconciler();

  beforeAll(async () => {
    // The two processors are declared directly rather than via
    // ProcessorsModule, so ReconcileScheduler never boots. An automatic sweep
    // every 60 seconds would enqueue jobs in the middle of these assertions.
    // A real reminder worker still runs: BullModule's explorer discovers any
    // provider carrying @Processor metadata.
    moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        DatabaseModule,
        ClockModule,
        JobsModule,
        NotificationsModule,
        TypeOrmModule.forFeature([Appointment]),
      ],
      providers: [
        AppointmentReminderProcessor,
        ReconciliationProcessor,
        { provide: WaitingListReconciler, useValue: reconciler },
      ],
    })
      .overrideProvider(Clock)
      .useValue(new FixedClock(NOW))
      .compile();

    await moduleRef.init();
    processor = moduleRef.get(ReconciliationProcessor);
    dataSource = moduleRef.get(DataSource);
    reminders = moduleRef.get<Queue>(getQueueToken(QUEUE_REMINDERS));
    waitingList = moduleRef.get<Queue>(getQueueToken(QUEUE_WAITING_LIST));
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    reconciler.stranded = [];
    reconciler.expired = 0;
    await flushTestRedis();
    await resetJobTables(dataSource);
  });

  it('sends a due reminder whose job was lost', async () => {
    const slot = await seedConfirmedAppointment(dataSource, {
      startAt: START_AT,
      endAt: END_AT,
    });
    await insertPendingReminder(dataSource, {
      appointmentId: slot.appointmentId,
      patientId: slot.patientId,
      scheduledAt: DUE_AT,
    });

    // Redis was flushed above: the delayed job genuinely does not exist.
    const summary = await processor.process();

    expect(summary.dueRemindersEnqueued).toBe(1);

    // The real reminder worker is running in this module, so the row ends SENT.
    await waitFor(async () => {
      const [row]: Array<{ status: string }> = await dataSource.query(
        'SELECT status FROM notifications WHERE appointment_id = $1',
        [slot.appointmentId],
      );
      return row.status === 'SENT';
    });
  });

  it('ignores a due reminder whose appointment was cancelled', async () => {
    const slot = await seedConfirmedAppointment(dataSource, {
      startAt: START_AT,
      endAt: END_AT,
    });
    await insertPendingReminder(dataSource, {
      appointmentId: slot.appointmentId,
      patientId: slot.patientId,
      scheduledAt: DUE_AT,
    });
    await cancelAppointment(dataSource, slot.appointmentId);

    const summary = await processor.process();

    expect(summary.dueRemindersEnqueued).toBe(0);

    const [row]: Array<{ status: string }> = await dataSource.query(
      'SELECT status FROM notifications WHERE appointment_id = $1',
      [slot.appointmentId],
    );
    expect(row.status).toBe('PENDING');
  });

  it('ignores a reminder that is not due yet', async () => {
    const slot = await seedConfirmedAppointment(dataSource, {
      startAt: START_AT,
      endAt: END_AT,
    });
    await insertPendingReminder(dataSource, {
      appointmentId: slot.appointmentId,
      patientId: slot.patientId,
      scheduledAt: new Date('2026-12-01T09:00:00.000Z'),
    });

    await expect(processor.process()).resolves.toMatchObject({
      dueRemindersEnqueued: 0,
    });
  });

  it('enqueues waiting-list processing for a stranded cancelled slot', async () => {
    reconciler.stranded = [{ doctorId: 'doc-1', slotStartAt: START_AT }];

    const summary = await processor.process();

    expect(summary.strandedSlotsEnqueued).toBe(1);

    const queued = await waitingList.getJobs(['waiting', 'delayed', 'active']);
    expect(queued).toHaveLength(1);
    expect(queued[0].id).toBe(`waitlist:doc-1:${START_AT.toISOString()}`);
    expect(queued[0].data).toEqual({
      doctorId: 'doc-1',
      slotStartAtIso: START_AT.toISOString(),
    });
  });

  it('reports the number of expired waiting-list entries', async () => {
    reconciler.expired = 3;

    await expect(processor.process()).resolves.toMatchObject({
      waitingEntriesExpired: 3,
    });
  });

  it('running twice produces no duplicate side effects', async () => {
    const slot = await seedConfirmedAppointment(dataSource, {
      startAt: START_AT,
      endAt: END_AT,
    });
    await insertPendingReminder(dataSource, {
      appointmentId: slot.appointmentId,
      patientId: slot.patientId,
      scheduledAt: DUE_AT,
    });
    reconciler.stranded = [{ doctorId: 'doc-1', slotStartAt: START_AT }];

    await processor.process();
    await waitFor(async () => {
      const [row]: Array<{ status: string }> = await dataSource.query(
        'SELECT status FROM notifications WHERE appointment_id = $1',
        [slot.appointmentId],
      );
      return row.status === 'SENT';
    });

    const [before]: Array<{ sent_at: Date }> = await dataSource.query(
      'SELECT sent_at FROM notifications WHERE appointment_id = $1',
      [slot.appointmentId],
    );

    await processor.process();

    const [after]: Array<{ sent_at: Date }> = await dataSource.query(
      'SELECT sent_at FROM notifications WHERE appointment_id = $1',
      [slot.appointmentId],
    );
    expect(after.sent_at).toEqual(before.sent_at);

    const [{ count }]: Array<{ count: string }> = await dataSource.query(
      "SELECT count(*)::text AS count FROM notifications WHERE status = 'SENT'",
    );
    expect(count).toBe('1');

    const queued = await waitingList.getJobs(['waiting', 'delayed', 'active']);
    expect(queued).toHaveLength(1);
  });

  it('is safe to run concurrently, as two worker replicas would', async () => {
    const slot = await seedConfirmedAppointment(dataSource, {
      startAt: START_AT,
      endAt: END_AT,
    });
    await insertPendingReminder(dataSource, {
      appointmentId: slot.appointmentId,
      patientId: slot.patientId,
      scheduledAt: DUE_AT,
    });
    reconciler.stranded = [{ doctorId: 'doc-1', slotStartAt: START_AT }];

    await Promise.all([
      processor.process(),
      processor.process(),
      processor.process(),
    ]);

    await waitFor(async () => {
      const [{ count }]: Array<{ count: string }> = await dataSource.query(
        "SELECT count(*)::text AS count FROM notifications WHERE status = 'SENT'",
      );
      return count === '1';
    });

    const [{ count }]: Array<{ count: string }> = await dataSource.query(
      'SELECT count(*)::text AS count FROM notifications',
    );
    expect(count).toBe('1');

    const waitingJobs = await waitingList.getJobs(['waiting', 'delayed', 'active']);
    expect(waitingJobs).toHaveLength(1);

    await expect(reminders.getFailedCount()).resolves.toBe(0);
  });
});
```

The last two tests are why the sweeper is allowed to exist at all. Three passes
in the same minute enqueue at most one reminder job each — collapsed by
`sweepReminderJobId`'s per-interval bucket — and even if all three got through,
`markSentIfPending` lets exactly one send. Redundant protection, at two
different layers, is the point: the queue-level collapse keeps the queue tidy,
and the database-level claim is the guarantee.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest --config test/jest-e2e.json test/reconciliation.e2e-spec.ts`
Expected: FAIL — `Cannot find module '../src/jobs/reconciliation.processor'`.

- [ ] **Step 4: Implement the sweeper**

Create `src/jobs/reconciliation.processor.ts`:

```ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Clock } from '../common/clock/clock';
import { NotificationType } from '../common/enums/notification-type.enum';
import { NotificationsRepository } from '../notifications/notifications.repository';
import { JobsService } from './jobs.service';
import {
  QUEUE_MAINTENANCE,
  RECONCILE_BATCH_LIMIT,
} from './queue.constants';
import { WaitingListReconciler } from './waiting-list-reconciler';

export interface ReconciliationSummary {
  strandedSlotsEnqueued: number;
  dueRemindersEnqueued: number;
  waitingEntriesExpired: number;
}

/**
 * Re-derives pending work from PostgreSQL every RECONCILE_EVERY_MS.
 *
 * This is the recovery path for three things:
 *  - a process that died between COMMIT and queue.add,
 *  - a Redis restart that lost the delayed jobs,
 *  - waiting-list entries that quietly became irrelevant.
 *
 * It queries only, decides nothing on its own, and enqueues jobs that are
 * themselves idempotent — which is what makes it safe to run twice, and safe
 * to run on several worker replicas at once.
 */
@Processor(QUEUE_MAINTENANCE)
export class ReconciliationProcessor extends WorkerHost {
  private readonly logger = new Logger(ReconciliationProcessor.name);

  constructor(
    private readonly notifications: NotificationsRepository,
    private readonly waitingListReconciler: WaitingListReconciler,
    private readonly jobs: JobsService,
    private readonly clock: Clock,
  ) {
    super();
  }

  async process(): Promise<ReconciliationSummary> {
    const now = this.clock.now();

    const summary: ReconciliationSummary = {
      strandedSlotsEnqueued: await this.enqueueStrandedSlots(now),
      dueRemindersEnqueued: await this.enqueueDueReminders(now),
      waitingEntriesExpired: await this.waitingListReconciler.expireStale(now),
    };

    if (
      summary.strandedSlotsEnqueued > 0 ||
      summary.dueRemindersEnqueued > 0 ||
      summary.waitingEntriesExpired > 0
    ) {
      this.logger.log(
        `Reconciliation: ${summary.strandedSlotsEnqueued} stranded slot(s), ` +
          `${summary.dueRemindersEnqueued} due reminder(s), ` +
          `${summary.waitingEntriesExpired} expired waiting entry/entries`,
      );
    }

    return summary;
  }

  /**
   * Pass 1: cancelled appointments whose slot still has WAITING entries.
   * The deterministic slot job id means re-enqueueing an already queued slot
   * is a no-op.
   */
  private async enqueueStrandedSlots(now: Date): Promise<number> {
    const slots = await this.waitingListReconciler.findStrandedSlots(
      now,
      RECONCILE_BATCH_LIMIT,
    );

    for (const slot of slots) {
      await this.jobs.enqueueSlotProcessing(slot.doctorId, slot.slotStartAt);
    }

    return slots.length;
  }

  /**
   * Pass 2: PENDING notifications past scheduled_at whose appointment is still
   * CONFIRMED. Enqueued rather than sent inline, so there is exactly one code
   * path that delivers a reminder.
   */
  private async enqueueDueReminders(now: Date): Promise<number> {
    const due = await this.notifications.findDuePending(now, RECONCILE_BATCH_LIMIT);

    const reminders = due.filter((row) => row.type === NotificationType.Reminder);
    const others = due.length - reminders.length;

    if (others > 0) {
      // The sweeper knows how to trigger reminders only. A due PENDING
      // WAITLIST_ASSIGNED row means Plan 7's assignment transaction left one
      // behind, which is a bug worth surfacing rather than swallowing.
      this.logger.warn(
        `${others} due notification(s) are of a type this sweeper cannot deliver`,
      );
    }

    for (const reminder of reminders) {
      await this.jobs.enqueueDueReminder(reminder.appointmentId, now);
    }

    return reminders.length;
  }
}
```

- [ ] **Step 5: Register the repeatable job**

Create `src/jobs/reconcile.scheduler.ts`:

```ts
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  JOB_RECONCILE,
  QUEUE_MAINTENANCE,
  RECONCILE_EVERY_MS,
  RECONCILE_SCHEDULER_ID,
} from './queue.constants';

/**
 * Registers the repeatable sweeper when the worker boots.
 *
 * upsertJobScheduler is keyed by RECONCILE_SCHEDULER_ID, so N worker replicas
 * calling this on startup produce one scheduler, not N. The sweeper's actions
 * are idempotent anyway, because two replicas can still execute the same
 * scheduled occurrence concurrently. See docs/INFRASTRUCTURE/Deployment.md.
 */
@Injectable()
export class ReconcileScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReconcileScheduler.name);

  constructor(
    @InjectQueue(QUEUE_MAINTENANCE) private readonly maintenance: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.maintenance.upsertJobScheduler(
      RECONCILE_SCHEDULER_ID,
      { every: RECONCILE_EVERY_MS },
      { name: JOB_RECONCILE, data: {} },
    );

    this.logger.log(
      `Reconciliation sweeper scheduled every ${RECONCILE_EVERY_MS}ms`,
    );
  }
}
```

- [ ] **Step 6: Wire the sweeper into `ProcessorsModule`**

Replace `src/jobs/processors.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Appointment } from '../appointments/appointment.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { AppointmentReminderProcessor } from './appointment-reminder.processor';
import { JobsModule } from './jobs.module';
import { ReconcileScheduler } from './reconcile.scheduler';
import { ReconciliationProcessor } from './reconciliation.processor';
import {
  NoWaitingListReconciler,
  WaitingListReconciler,
} from './waiting-list-reconciler';

/**
 * The BullMQ processors. Imported by src/worker.module.ts only.
 *
 * If this module were imported by AppModule, scaling the API to two replicas
 * would double the worker pool as a side effect. See docs/DECISIONS.md #13.
 */
@Module({
  imports: [
    JobsModule,
    NotificationsModule,
    // Entity-level dependency only. Plan 7 adds AppointmentsModule and
    // WaitingListModule here.
    TypeOrmModule.forFeature([Appointment]),
  ],
  providers: [
    AppointmentReminderProcessor,
    ReconciliationProcessor,
    ReconcileScheduler,
    // Plan 7 replaces this binding with an adapter over WaitingListService.
    { provide: WaitingListReconciler, useClass: NoWaitingListReconciler },
  ],
})
export class ProcessorsModule {}
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
docker compose up -d postgres redis
docker compose --profile test up -d postgres-test
npx jest --config test/jest-e2e.json test/reconciliation.e2e-spec.ts
```

Expected: PASS — 7 tests.

- [ ] **Step 8: Add the scheduler registration test**

Add these imports to the top of `test/reconciliation.e2e-spec.ts`, and extend
the existing `queue.constants` import to cover the three new names:

```ts
import { ReconcileScheduler } from '../src/jobs/reconcile.scheduler';
import {
  QUEUE_MAINTENANCE,
  QUEUE_REMINDERS,
  QUEUE_WAITING_LIST,
  RECONCILE_EVERY_MS,
  RECONCILE_SCHEDULER_ID,
} from '../src/jobs/queue.constants';
```

Then append this describe block at the end of the file:

```ts
describe('ReconcileScheduler', () => {
  let moduleRef: TestingModule;
  let scheduler: ReconcileScheduler;
  let maintenance: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, ClockModule, JobsModule],
      providers: [ReconcileScheduler],
    }).compile();

    await moduleRef.init();
    scheduler = moduleRef.get(ReconcileScheduler);
    maintenance = moduleRef.get<Queue>(getQueueToken(QUEUE_MAINTENANCE));
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await flushTestRedis();
  });

  it('registers one scheduler no matter how many replicas boot', async () => {
    await scheduler.onApplicationBootstrap();
    await scheduler.onApplicationBootstrap();
    await scheduler.onApplicationBootstrap();

    const schedulers = await maintenance.getJobSchedulers();

    expect(schedulers).toHaveLength(1);
    expect(schedulers[0].key).toBe(RECONCILE_SCHEDULER_ID);
    // BullMQ returns `every` as a string in the scheduler JSON.
    expect(String(schedulers[0].every)).toBe(String(RECONCILE_EVERY_MS));
  });
});
```

`upsert`, not `add`: three replicas booting must leave one scheduler behind, not
three sweepers running every 60 seconds.

- [ ] **Step 9: Run the full sweeper suite**

Run: `npx jest --config test/jest-e2e.json test/reconciliation.e2e-spec.ts`
Expected: PASS — 8 tests.

- [ ] **Step 10: Verify the sweeper recovers a wiped Redis in the running stack**

```bash
docker compose up --build -d
docker compose logs -f worker
```

In another shell, once at least one appointment has been booked through the API:

```bash
docker compose exec redis redis-cli flushall
```

Expected: within about 60 seconds the worker logs
`Reconciliation sweeper scheduled every 60000ms` again (the scheduler is
re-upserted on the next boot) — and if any reminder is due, a
`Reconciliation: ... due reminder(s)` line followed by `REMINDER sent:`. This is
the claim "Redis is a scheduler, not a store of record", demonstrated rather
than asserted.

Note: `flushall` also removes the job scheduler, so restart the worker
(`docker compose restart worker`) to re-register it. That restart is exactly
what a real Redis outage would require, and it is why the durable record lives
in PostgreSQL. Because Redis carries no persistence (`docs/DECISIONS.md` #14),
`docker compose restart redis` produces the same starting state as `flushall`;
`flushall` is used here only because it does not also restart the container.

- [ ] **Step 11: Run the whole suite**

```bash
npm test
npm run test:e2e
```

Expected: unit tests PASS (Plan 1's 13 plus 9 added here — 4 in
`queue.constants.spec.ts`, 5 in `jobs.service.spec.ts`); e2e PASS including
`notifications-schema`, `notifications-repository`, `reminder-queue`,
`appointment-reminder` and `reconciliation`.

- [ ] **Step 12: Commit**

```bash
git add src/jobs test/reconciliation.e2e-spec.ts
git commit -m "feat(jobs): add repeatable reconciliation sweeper for lost jobs and expiry"
```

---

## Definition of Done

- [ ] `docker compose up --build` starts `postgres`, `redis`, `migrate`, `api`
      and `worker`, with `migrate` exited 0 and `worker` running.
- [ ] `docker compose logs worker` contains
      `Reconciliation sweeper scheduled every 60000ms`.
- [ ] `docker compose logs api` contains no processor log lines — the API is not
      a job runner.
- [ ] `npm test` passes.
- [ ] `npm run test:e2e` passes.
- [ ] `npm run migration:revert` then `npm run migration:run` succeeds.
- [ ] `grep -rn "new Date()" src/ --include=*.ts` matches only
      `src/common/clock/clock.ts`.
- [ ] `grep -rn "reminders\.add\|waitingList\.add\|upsertJobScheduler" src/ --include=*.ts`
      matches only `src/jobs/jobs.service.ts` (three times) and
      `src/jobs/reconcile.scheduler.ts` (once). Enqueueing lives in exactly one
      place, so "enqueue only after commit" is reviewable rather than a claim
      spread across every service.
- [ ] `grep -rn "ProcessorsModule" src/ --include=*.ts` matches only
      `src/jobs/processors.module.ts` and `src/worker.module.ts`.
- [ ] Cancelling an appointment and then executing its reminder job directly
      sends nothing (`test/appointment-reminder.e2e-spec.ts`).
- [ ] Five concurrent `markSentIfPending` calls yield exactly one `true`
      (`test/notifications-repository.e2e-spec.ts`).
- [ ] Three concurrent sweeper passes leave exactly one SENT notification and
      one queued slot job (`test/reconciliation.e2e-spec.ts`).
- [ ] The suite refuses to run against Redis database 0:
      `$env:TEST_REDIS_URL='redis://localhost:6379'; npm run test:e2e` on
      PowerShell, or `TEST_REDIS_URL=redis://localhost:6379 npm run test:e2e`
      on a POSIX shell. Reset with `Remove-Item Env:TEST_REDIS_URL` afterwards.

The last five are the ones worth actually running. Everything else in this plan
is wiring; those five are the invariants it exists to establish.

---

## Next

Plan 7 (Waiting list) builds on: `QUEUE_WAITING_LIST`, `JOB_PROCESS_SLOT`,
`ProcessSlotJobData` and `processSlotJobId` from `src/jobs/queue.constants.ts`;
`NotificationsRepository.createPending` for both the `WAITLIST_ASSIGNED` row and
the assigned appointment's own `REMINDER` row; `JobsService.scheduleReminder`
for that appointment's delayed job; and the `WaitingListReconciler` binding in
`ProcessorsModule`, which it replaces with an adapter over `WaitingListService`.
