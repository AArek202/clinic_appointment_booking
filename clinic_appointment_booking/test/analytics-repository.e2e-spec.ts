import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AnalyticsRepository } from '../src/analytics/analytics.repository';
import {
  createAppointment,
  createBlock,
  createDoctor,
  createPatient,
  createSchedule,
  resetAnalyticsData,
} from './fixtures/analytics.fixture';

// All fixtures are hand-computed for Africa/Cairo in February 2026:
//   * Cairo is UTC+2 for the whole month (no DST transition; test/analytics-fixture.e2e-spec.ts pins this)
//   * 1 Feb 2026 is a Sunday and the month is exactly 28 days = 4 whole weeks
//   * therefore February 2026 contains exactly four Sundays: 1, 8, 15, 22
//   * local 10:00 = 08:00Z, local 11:00 = 09:00Z, local 14:00 = 12:00Z
describe('AnalyticsRepository.getDoctorMonthlyAnalytics', () => {
  let app: INestApplication;
  let ds: DataSource;
  let repository: AnalyticsRepository;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    ds = app.get(DataSource);
    repository = app.get(AnalyticsRepository);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetAnalyticsData(ds);
  });

  describe('counts, cancellation rate, peak hours and utilization', () => {
    let doctorId: string;

    beforeEach(async () => {
      doctorId = await createDoctor(ds, 'mix');
      const patientId = await createPatient(ds, 'mix');

      // Sundays only, 10:00-12:00 local, 30-minute slots.
      // Capacity = 4 Sundays x 120 minutes = 480 minutes. No blocks.
      await createSchedule(ds, {
        doctorId,
        dayOfWeek: 0, // 0 = Sunday, matching EXTRACT(DOW). docs/DATABASE.md
        startTime: '10:00:00',
        endTime: '12:00:00',
        slotDurationMinutes: 30,
      });

      // Sun 1 Feb 10:00-10:30 Cairo, CONFIRMED
      await createAppointment(ds, {
        doctorId,
        patientId,
        startAt: '2026-02-01T08:00:00Z',
        endAt: '2026-02-01T08:30:00Z',
      });
      // Sun 1 Feb 10:30-11:00 Cairo, CONFIRMED
      await createAppointment(ds, {
        doctorId,
        patientId,
        startAt: '2026-02-01T08:30:00Z',
        endAt: '2026-02-01T09:00:00Z',
      });
      // Sun 8 Feb 11:00-11:30 Cairo, CANCELLED
      await createAppointment(ds, {
        doctorId,
        patientId,
        startAt: '2026-02-08T09:00:00Z',
        endAt: '2026-02-08T09:30:00Z',
        status: 'CANCELLED',
      });
      // Sun 8 Feb 11:30-12:00 Cairo, CANCELLED
      await createAppointment(ds, {
        doctorId,
        patientId,
        startAt: '2026-02-08T09:30:00Z',
        endAt: '2026-02-08T10:00:00Z',
        status: 'CANCELLED',
      });
    });

    it('counts cancelled appointments in the total', async () => {
      const result = await repository.getDoctorMonthlyAnalytics(doctorId, 2026, 2);

      // 2 CONFIRMED + 2 CANCELLED = 4
      expect(result.totalAppointments).toBe(4);
    });

    it('computes the cancellation rate as cancelled / total * 100', async () => {
      const result = await repository.getDoctorMonthlyAnalytics(doctorId, 2026, 2);

      // 2 cancelled / 4 total * 100 = 50.00
      expect(result.cancellationRate).toBe(50);
    });

    it('excludes cancelled appointments from booked minutes', async () => {
      const result = await repository.getDoctorMonthlyAnalytics(doctorId, 2026, 2);

      // booked   = 2 CONFIRMED x 30 min                 =  60 minutes
      // capacity = 4 Sundays x (12:00 - 10:00) = 4 x 120 = 480 minutes
      // 60 / 480 * 100 = 12.50
      //
      // Counting the two cancelled rows as booked would give
      // 120 / 480 * 100 = 25.00, so this number is the assertion that the
      // total-appointments filter and the booked-minutes filter really differ.
      expect(result.utilizationRate).toBe(12.5);
    });

    it('ranks peak hours over confirmed appointments only', async () => {
      const result = await repository.getDoctorMonthlyAnalytics(doctorId, 2026, 2);

      // CONFIRMED local hours: 10 (08:00Z), 10 (08:30Z) -> hour 10 = 2
      // CANCELLED local hours: 11 (09:00Z), 11 (09:30Z) -> not counted
      // Including cancelled rows would tie hour 10 and hour 11 at 2 each and
      // return [10, 11].
      expect(result.peakHours).toEqual([10]);
    });
  });

  describe('month boundaries in clinic-local time', () => {
    let doctorId: string;

    beforeEach(async () => {
      doctorId = await createDoctor(ds, 'tz');
      const patientId = await createPatient(ds, 'tz');

      // 22:30Z on 31 Jan = 00:30 on 1 February in Cairo -> FEBRUARY
      await createAppointment(ds, {
        doctorId,
        patientId,
        startAt: '2026-01-31T22:30:00Z',
        endAt: '2026-01-31T23:00:00Z',
      });
      // 08:00Z on 15 Feb = 10:00 on 15 February in Cairo -> FEBRUARY
      await createAppointment(ds, {
        doctorId,
        patientId,
        startAt: '2026-02-15T08:00:00Z',
        endAt: '2026-02-15T08:30:00Z',
      });
      // 22:30Z on 28 Feb = 00:30 on 1 March in Cairo -> MARCH
      await createAppointment(ds, {
        doctorId,
        patientId,
        startAt: '2026-02-28T22:30:00Z',
        endAt: '2026-02-28T23:00:00Z',
      });
      // 23:00Z on 28 Feb = 01:00 on 1 March in Cairo -> MARCH
      await createAppointment(ds, {
        doctorId,
        patientId,
        startAt: '2026-02-28T23:00:00Z',
        endAt: '2026-02-28T23:30:00Z',
      });
    });

    // Every one of these three numbers differs from what UTC bucketing gives,
    // which is the point: a query that used UTC month boundaries would report
    // January 1, February 3, March 0 and still look entirely plausible.
    it('puts an appointment just after local midnight on the 1st in that month', async () => {
      const january = await repository.getDoctorMonthlyAnalytics(doctorId, 2026, 1);
      const february = await repository.getDoctorMonthlyAnalytics(doctorId, 2026, 2);

      expect(january.totalAppointments).toBe(0); // UTC bucketing would say 1
      expect(february.totalAppointments).toBe(2); // UTC bucketing would say 3
    });

    it('puts an appointment just after local midnight on the 1st of the next month in that month', async () => {
      const march = await repository.getDoctorMonthlyAnalytics(doctorId, 2026, 3);

      expect(march.totalAppointments).toBe(2); // UTC bucketing would say 0
    });
  });

  describe('peak hours with a tie', () => {
    it('returns every tied hour, ascending', async () => {
      const doctorId = await createDoctor(ds, 'tie');
      const patientId = await createPatient(ds, 'tie');

      // Inserted latest-hour-first on purpose: if array_agg lost its
      // ORDER BY, the result would come back as [14, 9] and this test would
      // catch it.
      // Sun 8 Feb 14:00 Cairo -> hour 14
      await createAppointment(ds, {
        doctorId,
        patientId,
        startAt: '2026-02-08T12:00:00Z',
        endAt: '2026-02-08T12:30:00Z',
      });
      // Sun 22 Feb 14:00 Cairo -> hour 14
      await createAppointment(ds, {
        doctorId,
        patientId,
        startAt: '2026-02-22T12:00:00Z',
        endAt: '2026-02-22T12:30:00Z',
      });
      // Sun 1 Feb 09:00 Cairo -> hour 9
      await createAppointment(ds, {
        doctorId,
        patientId,
        startAt: '2026-02-01T07:00:00Z',
        endAt: '2026-02-01T07:30:00Z',
      });
      // Sun 15 Feb 09:00 Cairo -> hour 9
      await createAppointment(ds, {
        doctorId,
        patientId,
        startAt: '2026-02-15T07:00:00Z',
        endAt: '2026-02-15T07:30:00Z',
      });
      // Sun 1 Feb 11:00 Cairo -> hour 11, the runner-up
      await createAppointment(ds, {
        doctorId,
        patientId,
        startAt: '2026-02-01T09:00:00Z',
        endAt: '2026-02-01T09:30:00Z',
      });

      const result = await repository.getDoctorMonthlyAnalytics(doctorId, 2026, 2);

      // hour  9 -> 2 bookings
      // hour 11 -> 1 booking
      // hour 14 -> 2 bookings
      // max = 2, so both 9 and 14 are peak hours; 11 is not.
      expect(result.peakHours).toEqual([9, 14]);
      expect(result.totalAppointments).toBe(5);
    });
  });

  describe('blocks are subtracted only where they overlap a working window', () => {
    it('subtracts a partial block proportionally and ignores one outside working hours', async () => {
      const doctorId = await createDoctor(ds, 'blocks');
      const patientId = await createPatient(ds, 'blocks');

      // Sundays only, 10:00-12:00 local, 30-minute slots.
      // Gross capacity = 4 Sundays x 120 = 480 minutes.
      await createSchedule(ds, {
        doctorId,
        dayOfWeek: 0, // Sunday
        startTime: '10:00:00',
        endTime: '12:00:00',
        slotDurationMinutes: 30,
      });

      // Block A: a whole vacation day.
      // Cairo Sun 8 Feb 00:00 -> Mon 9 Feb 00:00 = 07 Feb 22:00Z -> 08 Feb 22:00Z
      await createBlock(ds, {
        doctorId,
        startAt: '2026-02-07T22:00:00Z',
        endAt: '2026-02-08T22:00:00Z',
        reason: 'vacation',
      });

      // Block B: an emergency covering the first hour of Sun 15 Feb,
      // 10:00-11:00 Cairo = 08:00Z-09:00Z. Half of that window, so half of it
      // goes and the rest survives.
      await createBlock(ds, {
        doctorId,
        startAt: '2026-02-15T08:00:00Z',
        endAt: '2026-02-15T09:00:00Z',
        reason: 'emergency',
      });

      // Block C: Sun 15 Feb 18:00-20:00 Cairo = 16:00Z-18:00Z.
      // Entirely outside the 10:00-12:00 working window, so it must subtract
      // nothing at all. It also has to miss block B: blocks_no_overlap would
      // reject the insert outright if two blocks for one doctor intersected.
      await createBlock(ds, {
        doctorId,
        startAt: '2026-02-15T16:00:00Z',
        endAt: '2026-02-15T18:00:00Z',
        reason: 'evening admin',
      });

      // Three confirmed appointments on Sunday 1 February:
      // 10:00-10:30, 10:30-11:00, 11:00-11:30 Cairo = 90 booked minutes.
      await createAppointment(ds, {
        doctorId,
        patientId,
        startAt: '2026-02-01T08:00:00Z',
        endAt: '2026-02-01T08:30:00Z',
      });
      await createAppointment(ds, {
        doctorId,
        patientId,
        startAt: '2026-02-01T08:30:00Z',
        endAt: '2026-02-01T09:00:00Z',
      });
      await createAppointment(ds, {
        doctorId,
        patientId,
        startAt: '2026-02-01T09:00:00Z',
        endAt: '2026-02-01T09:30:00Z',
      });

      const result = await repository.getDoctorMonthlyAnalytics(doctorId, 2026, 2);

      // Windows, in Cairo local time:
      //   Sun  1 Feb 10:00-12:00 -> 120 minutes, nothing blocked        -> 120
      //   Sun  8 Feb 10:00-12:00 -> 120 minutes, fully inside block A   ->   0
      //   Sun 15 Feb 10:00-12:00 -> 120 minutes, block B takes 10:00-11:00 ->  60
      //   Sun 22 Feb 10:00-12:00 -> 120 minutes, nothing blocked        -> 120
      // available = 120 + 0 + 60 + 120 = 300 minutes
      // booked    = 3 x 30                         =  90 minutes
      //  90 / 300 * 100 = 30.00
      //
      // The partial block is the interesting one: it must remove exactly the
      // hour it covers, not the whole window and not nothing.
      expect(result.utilizationRate).toBe(30);

      // Guard rails: multirange difference is set difference, so it can never
      // remove more time than the window contains. Subtracting ranges one at a
      // time could -- two ranges covering the same minute would take it off
      // twice, driving a window negative and the percentage below zero. Since
      // Plan 3 added blocks_no_overlap that data is also unstorable, so this
      // asserts the query's own arithmetic rather than the constraint's work.
      expect(result.utilizationRate).toBeGreaterThanOrEqual(0);
      expect(result.utilizationRate).toBeLessThanOrEqual(100);

      // This fixture also fails if schedules.day_of_week ever stops meaning
      // 0 = Sunday: with ISO numbering the windows would land on Mondays
      // (2, 9, 16, 23 Feb), the Sunday blocks would miss them entirely, and
      // utilization would come back as 90 / 480 * 100 = 18.75.
      expect(result.totalAppointments).toBe(3);
      expect(result.peakHours).toEqual([10]); // hours 10, 10, 11 -> hour 10 wins
    });
  });

  describe('guarded divisions', () => {
    it('returns zeros for a month with no appointments', async () => {
      const doctorId = await createDoctor(ds, 'empty');
      await createSchedule(ds, {
        doctorId,
        dayOfWeek: 0,
        startTime: '10:00:00',
        endTime: '12:00:00',
        slotDurationMinutes: 30,
      });

      const result = await repository.getDoctorMonthlyAnalytics(doctorId, 2026, 2);

      // total = 0, so cancelled / NULLIF(0, 0) is NULL and COALESCE makes it 0.
      // Capacity is 480 minutes but booked is 0, so 0 / 480 * 100 = 0.00.
      expect(result).toEqual({
        totalAppointments: 0,
        cancellationRate: 0,
        peakHours: [],
        utilizationRate: 0,
      });
    });

    it('returns utilization 0 for a doctor with no schedule that month', async () => {
      const doctorId = await createDoctor(ds, 'noschedule');
      const patientId = await createPatient(ds, 'noschedule');

      // Sun 1 Feb 10:00-10:30 and 10:30-11:00 Cairo, both CONFIRMED.
      await createAppointment(ds, {
        doctorId,
        patientId,
        startAt: '2026-02-01T08:00:00Z',
        endAt: '2026-02-01T08:30:00Z',
      });
      await createAppointment(ds, {
        doctorId,
        patientId,
        startAt: '2026-02-01T08:30:00Z',
        endAt: '2026-02-01T09:00:00Z',
      });

      const result = await repository.getDoctorMonthlyAnalytics(doctorId, 2026, 2);

      // No schedule rows -> `windows` is empty -> available_minutes = 0.
      // 60 / NULLIF(0, 0) is NULL, and COALESCE makes it 0 rather than an error.
      expect(result.totalAppointments).toBe(2);
      expect(result.cancellationRate).toBe(0); // 0 cancelled / 2 total
      expect(result.utilizationRate).toBe(0);
      expect(result.peakHours).toEqual([10]); // both at local hour 10
    });

    it('returns a full row of zeros for a doctor id that does not exist', async () => {
      const result = await repository.getDoctorMonthlyAnalytics(
        '00000000-0000-4000-8000-000000000000',
        2026,
        2,
      );

      // Three single-row aggregates cross-joined always produce exactly one
      // row, so the repository never has to handle an empty result set.
      expect(result).toEqual({
        totalAppointments: 0,
        cancellationRate: 0,
        peakHours: [],
        utilizationRate: 0,
      });
    });
  });

  describe('the computation happens in PostgreSQL', () => {
    it('uses exactly one database round trip', async () => {
      const doctorId = await createDoctor(ds, 'roundtrip');
      const querySpy = jest.spyOn(ds, 'query');

      await repository.getDoctorMonthlyAnalytics(doctorId, 2026, 2);

      expect(querySpy).toHaveBeenCalledTimes(1);
      querySpy.mockRestore();
    });

    it('returns four computed scalars and no rows', async () => {
      const doctorId = await createDoctor(ds, 'scalars');
      const patientId = await createPatient(ds, 'scalars');
      await createAppointment(ds, {
        doctorId,
        patientId,
        startAt: '2026-02-01T08:00:00Z',
        endAt: '2026-02-01T08:30:00Z',
      });

      const result = await repository.getDoctorMonthlyAnalytics(doctorId, 2026, 2);

      expect(Object.keys(result).sort()).toEqual([
        'cancellationRate',
        'peakHours',
        'totalAppointments',
        'utilizationRate',
      ]);
      expect(typeof result.totalAppointments).toBe('number');
      expect(typeof result.cancellationRate).toBe('number');
      expect(typeof result.utilizationRate).toBe('number');
      expect(Array.isArray(result.peakHours)).toBe(true);
      expect(result.peakHours.every((h) => typeof h === 'number')).toBe(true);
    });
  });
});
