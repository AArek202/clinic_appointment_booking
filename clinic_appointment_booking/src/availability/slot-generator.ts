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
