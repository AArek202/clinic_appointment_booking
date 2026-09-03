/**
 * A wall-clock time of day, 'HH:mm' or 'HH:mm:ss', 24-hour, zero-padded.
 *
 * Hour 24 is rejected. A schedule row must satisfy start_time < end_time
 * (constraint schedules_time_valid), so it cannot cross midnight anyway, and
 * allowing '24:00:00' would give midnight two spellings.
 */
export const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/**
 * Seconds since midnight. Seconds rather than minutes because the `time`
 * column keeps seconds, and comparing at a coarser precision than the column
 * stores would let two rows that really do overlap look adjacent.
 */
export function timeOfDayToSeconds(value: string): number {
  if (!TIME_OF_DAY_PATTERN.test(value)) {
    throw new Error(`Not a valid time of day: '${value}'`);
  }

  const [hours, minutes, seconds = '0'] = value.split(':');

  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/** Rewrites any accepted spelling as the canonical 'HH:mm:ss'. */
export function normalizeTimeOfDay(value: string): string {
  const total = timeOfDayToSeconds(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}
