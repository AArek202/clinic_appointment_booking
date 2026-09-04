import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Job, Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Appointment } from '../src/appointments/appointment.entity';
import { ClockModule } from '../src/common/clock/clock.module';
import { NotificationType } from '../src/common/enums/notification-type.enum';
import { AppConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/database/database.module';
import { AppointmentReminderProcessor } from '../src/jobs/appointment-reminder.processor';
import { JobsModule } from '../src/jobs/jobs.module';
import {
  JOB_SEND_REMINDER,
  QUEUE_REMINDERS,
  SendReminderJobData,
} from '../src/jobs/queue.constants';
import { Notification } from '../src/notifications/notification.entity';
import { NotificationsModule } from '../src/notifications/notifications.module';
import { NotificationsRepository } from '../src/notifications/notifications.repository';
import { flushTestRedis, waitFor } from './redis-helper';
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
  const rows: Array<{ status: string; sent_at: Date | null }> =
    await dataSource.query(
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
      Array.from({ length: 5 }, () =>
        processor.process(reminderJob(slot.appointmentId)),
      ),
    );

    const [{ count }]: Array<{ count: string }> = await dataSource.query(
      "SELECT count(*)::text AS count FROM notifications WHERE status = 'SENT'",
    );
    expect(count).toBe('1');
  });
});

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
