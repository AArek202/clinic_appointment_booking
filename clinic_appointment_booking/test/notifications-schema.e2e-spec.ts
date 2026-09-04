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
