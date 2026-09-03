import { timeOfDayToSeconds } from './time-of-day';

/**
 * The part of a schedule row that decides whether two rows collide.
 *
 * Named ScheduleTimeWindow, not TimeRange: `docs/PLANS/00-interfaces.md`
 * already uses TimeRange for a pair of absolute instants, and these are
 * wall-clock times on a weekday.
 */
export interface ScheduleTimeWindow {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

/**
 * True when two windows fall on the same weekday and their
 * [startTime, endTime) intervals intersect.
 *
 * Half-open on purpose. A row ending at 12:00:00 and a row starting at
 * 12:00:00 are adjacent, not overlapping — a doctor working mornings and
 * afternoons is two rows that touch. This matches the '[)' bound used by the
 * appointments_no_overlap constraint (docs/DATABASE.md), and the two must
 * agree or availability and booking disagree at every boundary.
 */
export function windowsOverlap(
  a: ScheduleTimeWindow,
  b: ScheduleTimeWindow,
): boolean {
  if (a.dayOfWeek !== b.dayOfWeek) {
    return false;
  }

  const aStart = timeOfDayToSeconds(a.startTime);
  const aEnd = timeOfDayToSeconds(a.endTime);
  const bStart = timeOfDayToSeconds(b.startTime);
  const bEnd = timeOfDayToSeconds(b.endTime);

  return aStart < bEnd && bStart < aEnd;
}

/**
 * The first window in `existing` that overlaps `candidate`, or null.
 *
 * Generic so the caller gets its own row type back and can report the
 * conflicting row's id in the error body.
 */
export function findOverlappingWindow<T extends ScheduleTimeWindow>(
  candidate: ScheduleTimeWindow,
  existing: T[],
): T | null {
  return existing.find((window) => windowsOverlap(candidate, window)) ?? null;
}
