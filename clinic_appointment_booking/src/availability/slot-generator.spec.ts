import { generateSlots, overlaps, ScheduleWindow } from './slot-generator';

const range = (startIso: string, endIso: string) => ({
  startAt: new Date(startIso),
  endAt: new Date(endIso),
});

/** Monday, 10:00-12:00 local, 30-minute slots. Monday is 1. */
const mondayMorning: ScheduleWindow = {
  dayOfWeek: 1,
  startTime: '10:00:00',
  endTime: '12:00:00',
  slotDurationMinutes: 30,
};

function startTimes(slots: { startAt: Date }[]): string[] {
  return slots.map((slot) => slot.startAt.toISOString());
}

describe('overlaps', () => {
  it('detects a partial overlap', () => {
    expect(
      overlaps(
        range('2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z'),
        range('2026-10-05T10:15:00Z', '2026-10-05T10:45:00Z'),
      ),
    ).toBe(true);
  });

  it('detects full containment', () => {
    expect(
      overlaps(
        range('2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z'),
        range('2026-10-05T09:00:00Z', '2026-10-05T17:00:00Z'),
      ),
    ).toBe(true);
  });

  it('treats touching ranges as NOT overlapping', () => {
    // 10:00-10:30 and 10:30-11:00 are back-to-back, not overlapping.
    // Getting this wrong rejects every consecutive booking.
    expect(
      overlaps(
        range('2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z'),
        range('2026-10-05T10:30:00Z', '2026-10-05T11:00:00Z'),
      ),
    ).toBe(false);
  });

  it('treats disjoint ranges as not overlapping', () => {
    expect(
      overlaps(
        range('2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z'),
        range('2026-10-05T14:00:00Z', '2026-10-05T14:30:00Z'),
      ),
    ).toBe(false);
  });

  it('is symmetric', () => {
    const a = range('2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z');
    const b = range('2026-10-05T10:15:00Z', '2026-10-05T10:45:00Z');

    expect(overlaps(a, b)).toBe(overlaps(b, a));
  });
});

describe('generateSlots', () => {
  it('expands one window into consecutive slots', () => {
    const slots = generateSlots({
      fromDate: '2026-03-23',
      toDate: '2026-03-23',
      timeZone: 'Europe/London',
      schedules: [mondayMorning],
      blocks: [],
      booked: [],
    });

    // GMT: 10:00 local == 10:00Z
    expect(startTimes(slots)).toEqual([
      '2026-03-23T10:00:00.000Z',
      '2026-03-23T10:30:00.000Z',
      '2026-03-23T11:00:00.000Z',
      '2026-03-23T11:30:00.000Z',
    ]);
    expect(slots[0].endAt.toISOString()).toBe('2026-03-23T10:30:00.000Z');
  });

  it('keeps wall-clock times after the spring-forward transition', () => {
    const slots = generateSlots({
      fromDate: '2026-03-30',
      toDate: '2026-03-30',
      timeZone: 'Europe/London',
      schedules: [mondayMorning],
      blocks: [],
      booked: [],
    });

    // BST: the doctor still starts at 10:00 local, which is now 09:00Z.
    // Expanding in UTC instead would wrongly keep producing 10:00Z.
    expect(startTimes(slots)).toEqual([
      '2026-03-30T09:00:00.000Z',
      '2026-03-30T09:30:00.000Z',
      '2026-03-30T10:00:00.000Z',
      '2026-03-30T10:30:00.000Z',
    ]);
  });

  it('keeps wall-clock times after the autumn-back transition', () => {
    const before = generateSlots({
      fromDate: '2026-10-19',
      toDate: '2026-10-19',
      timeZone: 'Europe/London',
      schedules: [mondayMorning],
      blocks: [],
      booked: [],
    });
    const after = generateSlots({
      fromDate: '2026-10-26',
      toDate: '2026-10-26',
      timeZone: 'Europe/London',
      schedules: [mondayMorning],
      blocks: [],
      booked: [],
    });

    expect(before[0].startAt.toISOString()).toBe('2026-10-19T09:00:00.000Z');
    expect(after[0].startAt.toISOString()).toBe('2026-10-26T10:00:00.000Z');
  });

  it('spans a DST transition inside a single range', () => {
    const slots = generateSlots({
      fromDate: '2026-03-23',
      toDate: '2026-03-30',
      timeZone: 'Europe/London',
      schedules: [mondayMorning],
      blocks: [],
      booked: [],
    });

    // Two Mondays, four slots each, at different UTC offsets.
    expect(slots).toHaveLength(8);
    expect(slots[0].startAt.toISOString()).toBe('2026-03-23T10:00:00.000Z');
    expect(slots[4].startAt.toISOString()).toBe('2026-03-30T09:00:00.000Z');
  });

  it('returns nothing for a day with no matching schedule', () => {
    const slots = generateSlots({
      fromDate: '2026-03-24', // Tuesday
      toDate: '2026-03-24',
      timeZone: 'Europe/London',
      schedules: [mondayMorning],
      blocks: [],
      booked: [],
    });

    expect(slots).toEqual([]);
  });

  it('handles two windows on the same weekday with different durations', () => {
    const slots = generateSlots({
      fromDate: '2026-03-23',
      toDate: '2026-03-23',
      timeZone: 'Europe/London',
      schedules: [
        {
          dayOfWeek: 1,
          startTime: '10:00:00',
          endTime: '11:00:00',
          slotDurationMinutes: 30,
        },
        {
          dayOfWeek: 1,
          startTime: '14:00:00',
          endTime: '15:00:00',
          slotDurationMinutes: 15,
        },
      ],
      blocks: [],
      booked: [],
    });

    expect(startTimes(slots)).toEqual([
      '2026-03-23T10:00:00.000Z',
      '2026-03-23T10:30:00.000Z',
      '2026-03-23T14:00:00.000Z',
      '2026-03-23T14:15:00.000Z',
      '2026-03-23T14:30:00.000Z',
      '2026-03-23T14:45:00.000Z',
    ]);
  });

  it('does not emit a trailing partial slot', () => {
    const slots = generateSlots({
      fromDate: '2026-03-23',
      toDate: '2026-03-23',
      timeZone: 'Europe/London',
      // 70 minutes cannot hold three 30-minute slots.
      schedules: [
        {
          dayOfWeek: 1,
          startTime: '10:00:00',
          endTime: '11:10:00',
          slotDurationMinutes: 30,
        },
      ],
      blocks: [],
      booked: [],
    });

    expect(startTimes(slots)).toEqual([
      '2026-03-23T10:00:00.000Z',
      '2026-03-23T10:30:00.000Z',
    ]);
  });

  it('removes a slot fully covered by a block', () => {
    const slots = generateSlots({
      fromDate: '2026-03-23',
      toDate: '2026-03-23',
      timeZone: 'Europe/London',
      schedules: [mondayMorning],
      blocks: [range('2026-03-23T10:00:00Z', '2026-03-23T10:30:00Z')],
      booked: [],
    });

    expect(startTimes(slots)).not.toContain('2026-03-23T10:00:00.000Z');
    expect(slots).toHaveLength(3);
  });

  it('removes a slot only partially covered by a block', () => {
    const slots = generateSlots({
      fromDate: '2026-03-23',
      toDate: '2026-03-23',
      timeZone: 'Europe/London',
      schedules: [mondayMorning],
      // 10 minutes into the 11:00 slot is enough to make it unbookable.
      blocks: [range('2026-03-23T11:00:00Z', '2026-03-23T11:10:00Z')],
      booked: [],
    });

    expect(startTimes(slots)).not.toContain('2026-03-23T11:00:00.000Z');
    expect(slots).toHaveLength(3);
  });

  it('keeps a slot that merely touches a block', () => {
    const slots = generateSlots({
      fromDate: '2026-03-23',
      toDate: '2026-03-23',
      timeZone: 'Europe/London',
      schedules: [mondayMorning],
      // Block ends exactly when the 10:30 slot begins.
      blocks: [range('2026-03-23T10:00:00Z', '2026-03-23T10:30:00Z')],
      booked: [],
    });

    expect(startTimes(slots)).toContain('2026-03-23T10:30:00.000Z');
  });

  it('removes booked slots', () => {
    const slots = generateSlots({
      fromDate: '2026-03-23',
      toDate: '2026-03-23',
      timeZone: 'Europe/London',
      schedules: [mondayMorning],
      blocks: [],
      booked: [range('2026-03-23T10:30:00Z', '2026-03-23T11:00:00Z')],
    });

    expect(startTimes(slots)).not.toContain('2026-03-23T10:30:00.000Z');
    expect(slots).toHaveLength(3);
  });

  it('returns slots in ascending order', () => {
    const slots = generateSlots({
      fromDate: '2026-03-23',
      toDate: '2026-03-31',
      timeZone: 'Europe/London',
      schedules: [
        {
          dayOfWeek: 1,
          startTime: '14:00:00',
          endTime: '15:00:00',
          slotDurationMinutes: 30,
        },
        {
          dayOfWeek: 1,
          startTime: '10:00:00',
          endTime: '11:00:00',
          slotDurationMinutes: 30,
        },
      ],
      blocks: [],
      booked: [],
    });

    const times = slots.map((slot) => slot.startAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('is pure: identical inputs produce identical output', () => {
    const input = {
      fromDate: '2026-03-23',
      toDate: '2026-03-23',
      timeZone: 'Europe/London',
      schedules: [mondayMorning],
      blocks: [],
      booked: [],
    };

    expect(generateSlots(input)).toEqual(generateSlots(input));
  });
});
