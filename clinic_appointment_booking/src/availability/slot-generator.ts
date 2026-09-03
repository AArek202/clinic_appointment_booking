import { DateTime } from 'luxon';

/** A bookable slot. Half-open: [startAt, endAt). */
export interface Slot {
  startAt: Date;
  endAt: Date;
}

/** Any half-open interval of instants. */
export interface TimeRange {
  startAt: Date;
  endAt: Date;
}

/**
 * One weekly working window. Structurally satisfied by the Schedule entity,
 * so SchedulesRepository.findByDoctorId results can be passed straight in.
 */
export interface ScheduleWindow {
  /** 0 = Sunday .. 6 = Saturday, matching PostgreSQL EXTRACT(DOW). */
  dayOfWeek: number;
  /** 'HH:mm:ss' clinic-local wall-clock time. */
  startTime: string;
  endTime: string;
  slotDurationMinutes: number;
}

export interface GenerateSlotsInput {
  /** 'YYYY-MM-DD' clinic-local, inclusive. */
  fromDate: string;
  /** 'YYYY-MM-DD' clinic-local, inclusive. */
  toDate: string;
  /** IANA zone name, from CLINIC_TZ. */
  timeZone: string;
  schedules: ScheduleWindow[];
  blocks: TimeRange[];
  booked: TimeRange[];
}

export const MAX_AVAILABILITY_RANGE_DAYS = 62;

/**
 * True when two half-open ranges overlap.
 *
 * Strict comparisons on both sides: touching ranges do not overlap. This must
 * match the '[)' bound in the appointments exclusion constraint, or
 * availability listing and booking will disagree.
 */
export function overlaps(a: TimeRange, b: TimeRange): boolean {
  return (
    a.startAt.getTime() < b.endAt.getTime() &&
    a.endAt.getTime() > b.startAt.getTime()
  );
}

/** Luxon uses 1 = Monday .. 7 = Sunday; the database uses 0 = Sunday. */
function toDatabaseDayOfWeek(luxonWeekday: number): number {
  return luxonWeekday === 7 ? 0 : luxonWeekday;
}

function parseWallClock(time: string): { hour: number; minute: number } {
  const [hour, minute] = time.split(':').map(Number);
  return { hour, minute };
}

/**
 * Expands weekly schedules over a clinic-local date range and returns the
 * bookable slots as UTC instants, ascending.
 *
 * The expansion walks clinic-local calendar days and sets wall-clock times in
 * the clinic zone, converting to UTC only at the end. Expanding in UTC instead
 * would drift by an hour for part of the year in any DST-observing zone: the
 * doctor's "10:00" is a wall-clock fact, not a fixed instant.
 */
export function generateSlots(input: GenerateSlotsInput): Slot[] {
  const { fromDate, toDate, timeZone, schedules, blocks, booked } = input;

  const first = DateTime.fromISO(fromDate, { zone: timeZone }).startOf('day');
  const last = DateTime.fromISO(toDate, { zone: timeZone }).startOf('day');

  if (!first.isValid || !last.isValid) {
    throw new Error(
      `Invalid date range or time zone: ${fromDate}..${toDate} ${timeZone}`,
    );
  }

  const slots: Slot[] = [];

  for (let day = first; day <= last; day = day.plus({ days: 1 })) {
    const dayOfWeek = toDatabaseDayOfWeek(day.weekday);

    for (const schedule of schedules) {
      if (schedule.dayOfWeek !== dayOfWeek) {
        continue;
      }

      const windowStart = day.set({
        ...parseWallClock(schedule.startTime),
        second: 0,
        millisecond: 0,
      });
      const windowEnd = day.set({
        ...parseWallClock(schedule.endTime),
        second: 0,
        millisecond: 0,
      });

      for (
        let slotStart = windowStart;
        slotStart < windowEnd;
        slotStart = slotStart.plus({ minutes: schedule.slotDurationMinutes })
      ) {
        const slotEnd = slotStart.plus({
          minutes: schedule.slotDurationMinutes,
        });

        // A window that does not divide evenly leaves a short tail. Offering
        // it would create appointments off the grid.
        if (slotEnd > windowEnd) {
          break;
        }

        slots.push({
          startAt: slotStart.toUTC().toJSDate(),
          endAt: slotEnd.toUTC().toJSDate(),
        });
      }
    }
  }

  const unavailable = [...blocks, ...booked];
  const available = slots.filter(
    (slot) => !unavailable.some((range) => overlaps(slot, range)),
  );

  return available.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}
