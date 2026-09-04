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
