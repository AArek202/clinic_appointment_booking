import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Appointment } from '../src/appointments/appointment.entity';
import { AppModule } from '../src/app.module';
import { Clock, FixedClock } from '../src/common/clock/clock';
import { ClockModule } from '../src/common/clock/clock.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { AppConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/database/database.module';
import { AppointmentReminderProcessor } from '../src/jobs/appointment-reminder.processor';
import { JobsModule } from '../src/jobs/jobs.module';
import { ReconcileScheduler } from '../src/jobs/reconcile.scheduler';
import { ReconciliationProcessor } from '../src/jobs/reconciliation.processor';
import {
  QUEUE_MAINTENANCE,
  QUEUE_REMINDERS,
  QUEUE_WAITING_LIST,
  RECONCILE_EVERY_MS,
  RECONCILE_SCHEDULER_ID,
} from '../src/jobs/queue.constants';
import {
  StrandedSlot,
  WaitingListReconciler,
} from '../src/jobs/waiting-list-reconciler';
import { NotificationsModule } from '../src/notifications/notifications.module';
import { NotificationsRepository } from '../src/notifications/notifications.repository';
import { WaitingListRepository } from '../src/waiting-list/waiting-list.repository';
import { WaitingListReconcilerAdapter } from '../src/waiting-list/waiting-list-reconciler.adapter';
import { JobsService } from '../src/jobs/jobs.service';
import {
  createJwtService,
  seedAdmin,
  seedDoctor,
  seedPatient,
  truncateAll,
} from './helpers/seed.helper';
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

    const waitingJobs = await waitingList.getJobs([
      'waiting',
      'delayed',
      'active',
    ]);
    expect(waitingJobs).toHaveLength(1);

    await expect(reminders.getFailedCount()).resolves.toBe(0);
  });
});

const WAITING_LIST_SLOT = '2026-10-05T09:00:00.000Z';
const WAITING_LIST_NOW = new Date('2026-10-05T06:00:00.000Z');

describe('WaitingListReconcilerAdapter', () => {
  let app: INestApplication;
  let reconciliation: ReconciliationProcessor;
  let dataSource: DataSource;
  let waitingListQueue: Queue;
  let clock: FixedClock;
  let adminToken: string;
  let doctorId: string;
  let patientAToken: string;
  let patientBToken: string;
  let patientDToken: string;

  beforeAll(async () => {
    clock = new FixedClock(WAITING_LIST_NOW);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    dataSource = app.get(DataSource);
    waitingListQueue = app.get<Queue>(getQueueToken(QUEUE_WAITING_LIST));
    reconciliation = new ReconciliationProcessor(
      app.get(NotificationsRepository),
      new WaitingListReconcilerAdapter(app.get(WaitingListRepository)),
      app.get(JobsService),
      clock,
    );
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    clock.set(WAITING_LIST_NOW);
    await flushTestRedis();
    await truncateAll(dataSource);

    const jwt = createJwtService();
    const admin = await seedAdmin(dataSource, jwt);
    const doctor = await seedDoctor(dataSource, jwt);
    const patientA = await seedPatient(dataSource, jwt);
    const patientB = await seedPatient(dataSource, jwt);
    const patientD = await seedPatient(dataSource, jwt);

    adminToken = admin.token;
    doctorId = doctor.doctorId!;
    patientAToken = patientA.token;
    patientBToken = patientB.token;
    patientDToken = patientD.token;

    await request(app.getHttpServer())
      .post(`/doctors/${doctorId}/schedules`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        dayOfWeek: 1,
        startTime: '10:00',
        endTime: '16:00',
        slotDurationMinutes: 30,
      })
      .expect(201);
  });

  async function bookAs(
    token: string,
    startAt: string,
  ): Promise<{ id: string }> {
    const response = await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${token}`)
      .send({ doctorId, startAt })
      .expect(201);

    return response.body as { id: string };
  }

  async function cancelAs(token: string, appointmentId: string): Promise<void> {
    await request(app.getHttpServer())
      .post(`/appointments/${appointmentId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  }

  async function joinAs(
    token: string,
    slotStartAt: string,
    extra?: { expiresAt?: string },
  ): Promise<void> {
    await request(app.getHttpServer())
      .post('/waiting-list')
      .set('Authorization', `Bearer ${token}`)
      .send({ doctorId, slotStartAt, ...extra })
      .expect(201);
  }

  it('recovers an assignment whose enqueue was lost', async () => {
    const appointment = await bookAs(patientAToken, WAITING_LIST_SLOT);
    await joinAs(patientBToken, WAITING_LIST_SLOT);

    await dataSource.query(
      `UPDATE appointments SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1`,
      [appointment.id],
    );

    await reconciliation.process();

    const jobs = await waitingListQueue.getJobs([
      'waiting',
      'delayed',
      'active',
      'completed',
    ]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toEqual({
      doctorId,
      slotStartAtIso: WAITING_LIST_SLOT,
    });
  });

  it('does not re-enqueue a slot that already has a confirmed booking', async () => {
    const appointment = await bookAs(patientAToken, WAITING_LIST_SLOT);
    await joinAs(patientBToken, WAITING_LIST_SLOT);
    await cancelAs(patientAToken, appointment.id);
    await bookAs(patientDToken, WAITING_LIST_SLOT);

    await waitingListQueue.obliterate({ force: true });
    await reconciliation.process();

    const jobs = await waitingListQueue.getJobs([
      'waiting',
      'delayed',
      'active',
      'completed',
    ]);
    expect(jobs).toHaveLength(0);
  });

  it('expires entries whose deadline has passed', async () => {
    await bookAs(patientAToken, WAITING_LIST_SLOT);
    await joinAs(patientBToken, WAITING_LIST_SLOT, {
      expiresAt: '2026-10-05T05:00:00.000Z',
    });

    await reconciliation.process();

    const [entry] = await dataSource.query(`SELECT status FROM waiting_list`);
    expect(entry.status).toBe('EXPIRED');
  });

  it('is safe to run twice', async () => {
    const appointment = await bookAs(patientAToken, WAITING_LIST_SLOT);
    await joinAs(patientBToken, WAITING_LIST_SLOT);
    await dataSource.query(
      `UPDATE appointments SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1`,
      [appointment.id],
    );

    await reconciliation.process();
    await reconciliation.process();

    const jobs = await waitingListQueue.getJobs([
      'waiting',
      'delayed',
      'active',
      'completed',
    ]);
    expect(jobs).toHaveLength(1);
  });
});

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
