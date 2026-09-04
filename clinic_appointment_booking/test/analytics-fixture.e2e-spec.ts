import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DateTime } from 'luxon';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import {
  createAppointment,
  createDoctor,
  createPatient,
  resetAnalyticsData,
} from './fixtures/analytics.fixture';

describe('analytics fixtures', () => {
  let app: INestApplication;
  let ds: DataSource;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    ds = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  // Every expected value in the analytics tests is hand-computed for
  // Africa/Cairo. If the suite runs under a different zone the arithmetic in
  // those comments is wrong, so fail loudly here rather than subtly there.
  it('runs with CLINIC_TZ = Africa/Cairo', () => {
    expect(process.env.CLINIC_TZ).toBe('Africa/Cairo');
  });

  // Egypt observes DST from the last Friday of April to the last Thursday of
  // October, so February 2026 is UTC+2 from the 1st to the 28th with no
  // transition inside it. That is the only reason the fixtures can use a flat
  // "+2" everywhere.
  it('February 2026 is UTC+2 in Africa/Cairo for the whole month', () => {
    for (const day of ['2026-02-01', '2026-02-15', '2026-02-28']) {
      const offsetMinutes = DateTime.fromISO(`${day}T12:00`, {
        zone: 'Africa/Cairo',
      }).offset;
      expect(offsetMinutes).toBe(120); // +2 hours
    }
  });

  // These four instants are the month-boundary fixtures used in Task 2. Pinning
  // them here means the "// = Cairo ..." comments there are checked, not
  // trusted.
  it.each([
    ['2026-01-31T22:30:00Z', '2026-02-01 00:30'],
    ['2026-02-15T08:00:00Z', '2026-02-15 10:00'],
    ['2026-02-28T22:30:00Z', '2026-03-01 00:30'],
    ['2026-02-28T23:00:00Z', '2026-03-01 01:00'],
  ])('%s is %s in Africa/Cairo', (utc, local) => {
    expect(
      DateTime.fromISO(utc, { zone: 'utc' })
        .setZone('Africa/Cairo')
        .toFormat('yyyy-MM-dd HH:mm'),
    ).toBe(local);
  });

  it('February 2026 has exactly four Sundays: the 1st, 8th, 15th and 22nd', () => {
    const sundays = [1, 8, 15, 22].map(
      (d) => DateTime.fromObject({ year: 2026, month: 2, day: d }, { zone: 'Africa/Cairo' }).weekday,
    );

    // Luxon uses ISO weekdays, where Sunday is 7. PostgreSQL EXTRACT(DOW)
    // returns 0 for the same day, which is the convention schedules.day_of_week
    // uses (docs/DATABASE.md).
    expect(sundays).toEqual([7, 7, 7, 7]);
    expect(DateTime.fromObject({ year: 2026, month: 2, day: 28 }).daysInMonth).toBe(28);
  });

  it('writes back exactly the rows it was given', async () => {
    await resetAnalyticsData(ds);
    const doctorId = await createDoctor(ds, 'fixture');
    const patientId = await createPatient(ds, 'fixture');

    await createAppointment(ds, {
      doctorId,
      patientId,
      startAt: '2026-02-01T08:00:00Z',
      endAt: '2026-02-01T08:30:00Z',
      status: 'CANCELLED',
    });

    const rows = await ds.query(
      `SELECT status, start_at, end_at, cancelled_at IS NOT NULL AS is_cancelled
       FROM appointments WHERE doctor_id = $1`,
      [doctorId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('CANCELLED');
    expect(rows[0].is_cancelled).toBe(true);
    expect(new Date(rows[0].start_at).toISOString()).toBe('2026-02-01T08:00:00.000Z');
    expect(new Date(rows[0].end_at).toISOString()).toBe('2026-02-01T08:30:00.000Z');
  });

  it('resetAnalyticsData removes everything it created', async () => {
    await resetAnalyticsData(ds);
    const [{ count }] = await ds.query('SELECT COUNT(*)::int AS count FROM appointments');
    expect(count).toBe(0);
  });
});
