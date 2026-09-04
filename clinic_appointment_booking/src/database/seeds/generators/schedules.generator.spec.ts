import { Rng } from '../random';
import { FULL_SCALE } from '../seed.config';
import { buildBlocks, buildSchedules } from './schedules.generator';

const popular = FULL_SCALE.tiers[0];
const quiet = FULL_SCALE.tiers[3];

describe('buildSchedules', () => {
  it('creates one row per working day per window', () => {
    const rows = buildSchedules('doctor-1', popular);

    expect(rows).toHaveLength(popular.workingDays.length * popular.windows.length);
  });

  it('uses 0 = Sunday day-of-week values inside 0..6', () => {
    const rows = buildSchedules('doctor-1', quiet);

    for (const row of rows) {
      expect(row.dayOfWeek).toBeGreaterThanOrEqual(0);
      expect(row.dayOfWeek).toBeLessThanOrEqual(6);
    }
  });

  it('never produces two overlapping windows on the same weekday', () => {
    const rows = buildSchedules('doctor-1', popular);

    for (const day of popular.workingDays) {
      const sameDay = rows
        .filter((row) => row.dayOfWeek === day)
        .sort((a, b) => a.startTime.localeCompare(b.startTime));

      for (let i = 1; i < sameDay.length; i += 1) {
        expect(sameDay[i].startTime >= sameDay[i - 1].endTime).toBe(true);
      }
    }
  });

  it('uses the tier slot duration and a legal value', () => {
    const rows = buildSchedules('doctor-1', quiet);

    for (const row of rows) {
      expect([15, 30, 60]).toContain(row.slotDurationMinutes);
      expect(row.slotDurationMinutes).toBe(quiet.slotDurationMinutes);
    }
  });
});

describe('buildBlocks', () => {
  it('produces blocks whose end is strictly after their start', () => {
    const blocks = buildBlocks(
      'doctor-1',
      FULL_SCALE,
      new Rng(1),
      '2026-01-01',
      '2026-12-31',
      'Africa/Cairo',
    );

    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.endAt.getTime()).toBeGreaterThan(block.startAt.getTime());
    }
  });

  it('keeps every block inside the seed window', () => {
    const from = Date.parse('2026-01-01T00:00:00Z');
    const to = Date.parse('2027-01-02T00:00:00Z');
    const blocks = buildBlocks(
      'doctor-1',
      FULL_SCALE,
      new Rng(2),
      '2026-01-01',
      '2026-12-31',
      'Africa/Cairo',
    );

    for (const block of blocks) {
      expect(block.startAt.getTime()).toBeGreaterThanOrEqual(from);
      expect(block.endAt.getTime()).toBeLessThanOrEqual(to);
    }
  });

  it('never produces two blocks that overlap', () => {
    // blocks_no_overlap would abort the COPY with SQLSTATE 23P01.
    for (const seed of [1, 2, 3, 4, 5]) {
      const blocks = buildBlocks(
        'doctor-1',
        FULL_SCALE,
        new Rng(seed),
        '2026-01-01',
        '2026-12-31',
        'Africa/Cairo',
      ).sort((a, b) => a.startAt.getTime() - b.startAt.getTime());

      for (let i = 1; i < blocks.length; i += 1) {
        expect(blocks[i].startAt.getTime()).toBeGreaterThanOrEqual(
          blocks[i - 1].endAt.getTime(),
        );
      }
    }
  });
});
