import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { encodeCopyRow } from '../copy-writer';
import { Rng } from '../random';
import { DoctorTier, SeedConfig } from '../seed.config';

export const SCHEDULE_COLUMNS = [
  'id',
  'doctor_id',
  'day_of_week',
  'start_time',
  'end_time',
  'slot_duration_minutes',
];

export const BLOCK_COLUMNS = [
  'id',
  'doctor_id',
  'start_at',
  'end_at',
  'reason',
];

export interface ScheduleRow {
  id: string;
  doctorId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  slotDurationMinutes: number;
}

export interface BlockRow {
  id: string;
  doctorId: string;
  startAt: Date;
  endAt: Date;
  reason: string;
}

/**
 * One row per (working day, window). The windows within a tier are disjoint by
 * construction, so no two rows for the same weekday overlap and the seeded data
 * satisfies the service-layer rule in docs/FEATURES/Schedules.md.
 */
export function buildSchedules(
  doctorId: string,
  tier: DoctorTier,
): ScheduleRow[] {
  const rows: ScheduleRow[] = [];

  for (const dayOfWeek of tier.workingDays) {
    for (const window of tier.windows) {
      rows.push({
        id: randomUUID(),
        doctorId,
        dayOfWeek,
        startTime: window.startTime,
        endTime: window.endTime,
        slotDurationMinutes: tier.slotDurationMinutes,
      });
    }
  }

  return rows;
}

/**
 * A mixture of full vacation days and short emergency blocks, matching the two
 * examples in docs/DATABASE.md. Blocks are generated before appointments and
 * are subtracted from the slot grid, so no seeded appointment ever sits inside
 * a seeded block.
 *
 * At most one block per doctor per day. blocks_no_overlap rejects two blocks
 * for one doctor that share a minute, and a full-day block covers every
 * candidate short block on the same day, so one per day is the simplest rule
 * that cannot violate it. Duplicate day draws are skipped rather than retried,
 * which is why the row count is "up to `count`" and not exactly `count`.
 */
export function buildBlocks(
  doctorId: string,
  config: SeedConfig,
  rng: Rng,
  fromDate: string,
  toDate: string,
  timeZone: string,
): BlockRow[] {
  const start = DateTime.fromISO(fromDate, { zone: timeZone }).startOf('day');
  const end = DateTime.fromISO(toDate, { zone: timeZone }).endOf('day');
  const totalDays = Math.max(1, Math.floor(end.diff(start, 'days').days));
  const count = Math.max(
    1,
    Math.round((config.blocksPerDoctorPerYear * totalDays) / 365),
  );

  const rows: BlockRow[] = [];
  const usedDays = new Set<number>();

  for (let i = 0; i < count; i += 1) {
    const dayOffset = rng.int(0, totalDays - 1);
    if (usedDays.has(dayOffset)) {
      continue;
    }
    usedDays.add(dayOffset);

    const day = start.plus({ days: dayOffset });
    const fullDay = rng.chance(0.4);

    const startAt = fullDay
      ? day.startOf('day')
      : day.set({
          hour: rng.int(9, 17),
          minute: rng.pick([0, 15, 30, 45]),
          second: 0,
          millisecond: 0,
        });
    const endAt = fullDay
      ? startAt.plus({ days: 1 })
      : startAt.plus({ minutes: rng.pick([30, 60, 90]) });

    rows.push({
      id: randomUUID(),
      doctorId,
      startAt: startAt.toUTC().toJSDate(),
      endAt: endAt.toUTC().toJSDate(),
      reason: fullDay ? 'vacation' : 'emergency',
    });
  }

  return rows;
}

export function scheduleToCopyRow(row: ScheduleRow): string {
  return encodeCopyRow([
    row.id,
    row.doctorId,
    row.dayOfWeek,
    row.startTime,
    row.endTime,
    row.slotDurationMinutes,
  ]);
}

export function blockToCopyRow(row: BlockRow): string {
  return encodeCopyRow([
    row.id,
    row.doctorId,
    row.startAt,
    row.endAt,
    row.reason,
  ]);
}
