# Availability & Slot Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** List a doctor's available slots for a date range, correctly across
Daylight Saving Time — and expose the pure `resolveSlot` function that Plan 5's
booking path uses to snap a request onto the slot grid.

**Architecture:** All slot arithmetic lives in one pure module,
`src/availability/slot-generator.ts`. No DI, no database, no clock. Weekly
schedules are wall-clock; appointments are instants; the conversion happens in
exactly one place. The service layer only fetches rows and calls into it.

**Tech Stack:** NestJS 11, Luxon, TypeORM, PostgreSQL 16, Jest 30, Supertest.

## Global Constraints

- Names come from `docs/PLANS/00-interfaces.md`, which wins on any conflict.
- Slots are half-open `[startAt, endAt)`. This must agree with the `'[)'` range
  bound used by Plan 5's exclusion constraints, or availability and booking will
  disagree about back-to-back slots. (`docs/DATABASE.md`)
- `schedules.day_of_week` is **0 = Sunday**; Luxon's `weekday` is
  **1 = Monday … 7 = Sunday**. Every conversion between them is explicit.
- `MAX_AVAILABILITY_RANGE_DAYS = 62`. (`docs/FEATURES/Availability.md`)
- `CLINIC_TZ` is read from `ConfigService`, never hardcoded, and never
  `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- The generator is pure: same inputs, same outputs, no `new Date()` and no
  `DateTime.now()`.
- Commit messages follow `docs/DEVELOPMENT.md`.

---

## File Structure

**Created:**

```text
src/availability/
  slot-generator.ts          pure functions: overlaps, generateSlots, resolveSlot
  slot-generator.spec.ts     the densest unit test surface in the project
  availability.repository.ts
  availability.service.ts
  availability.controller.ts
  availability.module.ts
  dto/availability-query.dto.ts

test/availability.e2e-spec.ts
```

**Modified:** `src/app.module.ts`.

One module, two clearly separated halves: the pure half is exhaustively unit
tested with no infrastructure, and the impure half is thin enough that its e2e
tests only need to prove the wiring.

---

## Task 1: Interval overlap

Smallest piece, and the one every other piece depends on.

**Files:**
- Create: `src/availability/slot-generator.ts`
- Test: `src/availability/slot-generator.spec.ts`

**Interfaces:**
- Produces: `Slot`, `TimeRange`, `ScheduleWindow`, `GenerateSlotsInput`,
  `MAX_AVAILABILITY_RANGE_DAYS`, `overlaps`.

- [ ] **Step 1: Write the failing test**

```ts
// src/availability/slot-generator.spec.ts
import { overlaps } from './slot-generator';

const range = (startIso: string, endIso: string) => ({
  startAt: new Date(startIso),
  endAt: new Date(endIso),
});

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/availability/slot-generator.spec.ts`
Expected: FAIL — `Cannot find module './slot-generator'`.

- [ ] **Step 3: Write the types and `overlaps`**

```ts
// src/availability/slot-generator.ts

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
  return a.startAt.getTime() < b.endAt.getTime() && a.endAt.getTime() > b.startAt.getTime();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/availability/slot-generator.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/availability/slot-generator.ts src/availability/slot-generator.spec.ts
git commit -m "feat(availability): add half-open interval overlap helper"
```

---

## Task 2: Slot generation, including DST

**Files:**
- Modify: `src/availability/slot-generator.ts`
- Modify: `src/availability/slot-generator.spec.ts`

**Interfaces:**
- Produces: `generateSlots(input: GenerateSlotsInput): Slot[]`, ascending by
  `startAt`.

### Why the DST tests use `Europe/London`

The unit tests below use `Europe/London` rather than the project's default
`Africa/Cairo`. London's rule — last Sunday in March to last Sunday in October —
has been stable for decades, so the expected UTC instants are stable across
tzdata updates. Egypt suspended DST from 2015 to 2022 and reinstated it in 2023,
so its transition dates vary between tzdata versions and a test asserting them
could fail purely because the base image updated.

The zone is a parameter of a pure function, so testing with London proves the
logic. The e2e tests in Task 4 exercise the configured `CLINIC_TZ`.

Verified 2026 transitions for `Europe/London`:

| Date | Local offset |
|---|---|
| 2026-03-23 (Mon) | GMT, UTC+0 |
| 2026-03-29 01:00 UTC | GMT to BST |
| 2026-03-30 (Mon) | BST, UTC+1 |
| 2026-10-19 (Mon) | BST, UTC+1 |
| 2026-10-25 01:00 UTC | BST to GMT |
| 2026-10-26 (Mon) | GMT, UTC+0 |

Confirm these weekdays with `date -d 2026-03-30 +%A` (or Luxon) before relying
on them. If any differ, fix the dates rather than the assertions.

- [ ] **Step 1: Write the failing tests**

Add to `src/availability/slot-generator.spec.ts`:

```ts
import { generateSlots, ScheduleWindow } from './slot-generator';

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
        { dayOfWeek: 1, startTime: '10:00:00', endTime: '11:00:00', slotDurationMinutes: 30 },
        { dayOfWeek: 1, startTime: '14:00:00', endTime: '15:00:00', slotDurationMinutes: 15 },
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
        { dayOfWeek: 1, startTime: '10:00:00', endTime: '11:10:00', slotDurationMinutes: 30 },
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
        { dayOfWeek: 1, startTime: '14:00:00', endTime: '15:00:00', slotDurationMinutes: 30 },
        { dayOfWeek: 1, startTime: '10:00:00', endTime: '11:00:00', slotDurationMinutes: 30 },
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
```

The `keeps a slot that merely touches a block` test is the counterpart to the
touching-ranges test in Task 1. Without it, an inclusive comparison would remove
one extra legitimate slot per block, and the bug would look like an off-by-one
nobody can place.

The ordering test matters because schedules arrive ordered by `startTime` but
slots are generated per day, so a naive concatenation across days and windows can
come out unsorted.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/availability/slot-generator.spec.ts`
Expected: FAIL — `generateSlots is not a function`.

- [ ] **Step 3: Implement `generateSlots`**

Add to `src/availability/slot-generator.ts`:

```ts
import { DateTime } from 'luxon';

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
    throw new Error(`Invalid date range or time zone: ${fromDate}..${toDate} ${timeZone}`);
  }

  const slots: Slot[] = [];

  for (let day = first; day <= last; day = day.plus({ days: 1 })) {
    const dayOfWeek = toDatabaseDayOfWeek(day.weekday);

    for (const schedule of schedules) {
      if (schedule.dayOfWeek !== dayOfWeek) {
        continue;
      }

      const windowStart = day.set({ ...parseWallClock(schedule.startTime), second: 0, millisecond: 0 });
      const windowEnd = day.set({ ...parseWallClock(schedule.endTime), second: 0, millisecond: 0 });

      for (
        let slotStart = windowStart;
        slotStart < windowEnd;
        slotStart = slotStart.plus({ minutes: schedule.slotDurationMinutes })
      ) {
        const slotEnd = slotStart.plus({ minutes: schedule.slotDurationMinutes });

        // A window that does not divide evenly leaves a short tail. Offering
        // it would create appointments off the grid.
        if (slotEnd > windowEnd) {
          break;
        }

        slots.push({ startAt: slotStart.toUTC().toJSDate(), endAt: slotEnd.toUTC().toJSDate() });
      }
    }
  }

  const unavailable = [...blocks, ...booked];
  const available = slots.filter((slot) => !unavailable.some((range) => overlaps(slot, range)));

  return available.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}
```

Two Luxon details worth being able to explain. `plus({ minutes })` adds an exact
duration, so a slot never silently becomes 90 real minutes across a transition.
And `day.set({ hour })` on a spring-forward day, for a wall-clock time that does
not exist locally, returns the shifted time rather than throwing — irrelevant for
daytime clinic hours, but it is why a 01:00–03:00 schedule on a transition day
would produce a short day rather than an error.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/availability/slot-generator.spec.ts`
Expected: PASS — 18 tests.

- [ ] **Step 5: Commit**

```bash
git add src/availability/slot-generator.ts src/availability/slot-generator.spec.ts
git commit -m "feat(availability): expand weekly schedules into UTC slots across DST"
```

---

## Task 3: Resolving a requested instant onto the grid

This is what Plan 5's booking path calls. It is layer 1 of the concurrency
strategy in `docs/INFRASTRUCTURE/Concurrency.md`.

**Files:**
- Modify: `src/availability/slot-generator.ts`
- Modify: `src/availability/slot-generator.spec.ts`

**Interfaces:**
- Produces: `resolveSlot(startAt: Date, schedules: ScheduleWindow[], timeZone: string): Slot | null`.

- [ ] **Step 1: Write the failing tests**

```ts
import { resolveSlot } from './slot-generator';

describe('resolveSlot', () => {
  it('resolves an on-grid instant and derives endAt', () => {
    const slot = resolveSlot(
      new Date('2026-03-23T10:30:00Z'),
      [mondayMorning],
      'Europe/London',
    );

    expect(slot).not.toBeNull();
    expect(slot!.startAt.toISOString()).toBe('2026-03-23T10:30:00.000Z');
    expect(slot!.endAt.toISOString()).toBe('2026-03-23T11:00:00.000Z');
  });

  it('resolves correctly after a DST transition', () => {
    // 09:00Z is 10:00 local BST, which is on the grid.
    const onGrid = resolveSlot(
      new Date('2026-03-30T09:00:00Z'),
      [mondayMorning],
      'Europe/London',
    );
    expect(onGrid).not.toBeNull();

    // 10:00Z is 11:00 local BST -- also on the grid, but a different slot.
    const later = resolveSlot(
      new Date('2026-03-30T10:00:00Z'),
      [mondayMorning],
      'Europe/London',
    );
    expect(later!.endAt.toISOString()).toBe('2026-03-30T10:30:00.000Z');
  });

  it('rejects an instant that is not on the grid', () => {
    // 10:07 local against a 30-minute grid.
    expect(
      resolveSlot(new Date('2026-03-23T10:07:00Z'), [mondayMorning], 'Europe/London'),
    ).toBeNull();
  });

  it('rejects an instant carrying seconds', () => {
    expect(
      resolveSlot(new Date('2026-03-23T10:00:30Z'), [mondayMorning], 'Europe/London'),
    ).toBeNull();
  });

  it('rejects an instant before the window opens', () => {
    expect(
      resolveSlot(new Date('2026-03-23T09:30:00Z'), [mondayMorning], 'Europe/London'),
    ).toBeNull();
  });

  it('rejects the window end instant itself', () => {
    // 12:00 local is the exclusive end of a 10:00-12:00 window.
    expect(
      resolveSlot(new Date('2026-03-23T12:00:00Z'), [mondayMorning], 'Europe/London'),
    ).toBeNull();
  });

  it('rejects an instant in the gap between two windows', () => {
    const schedules: ScheduleWindow[] = [
      { dayOfWeek: 1, startTime: '10:00:00', endTime: '11:00:00', slotDurationMinutes: 30 },
      { dayOfWeek: 1, startTime: '14:00:00', endTime: '15:00:00', slotDurationMinutes: 30 },
    ];

    // 12:00 local falls between the morning and afternoon windows.
    expect(
      resolveSlot(new Date('2026-03-23T12:00:00Z'), schedules, 'Europe/London'),
    ).toBeNull();
  });

  it('resolves against the correct window when a weekday has two', () => {
    const schedules: ScheduleWindow[] = [
      { dayOfWeek: 1, startTime: '10:00:00', endTime: '11:00:00', slotDurationMinutes: 30 },
      { dayOfWeek: 1, startTime: '14:00:00', endTime: '15:00:00', slotDurationMinutes: 15 },
    ];

    const afternoon = resolveSlot(
      new Date('2026-03-23T14:15:00Z'),
      schedules,
      'Europe/London',
    );

    // The afternoon window's 15-minute duration, not the morning's 30.
    expect(afternoon!.endAt.toISOString()).toBe('2026-03-23T14:30:00.000Z');
  });

  it('rejects an instant on a weekday with no schedule', () => {
    expect(
      resolveSlot(new Date('2026-03-24T10:00:00Z'), [mondayMorning], 'Europe/London'),
    ).toBeNull();
  });

  it('rejects a last slot that would run past the window end', () => {
    // 10:50 is on a 10-minute grid from 10:00, but 10:50+30 exceeds 11:10.
    const schedules: ScheduleWindow[] = [
      { dayOfWeek: 1, startTime: '10:00:00', endTime: '11:10:00', slotDurationMinutes: 30 },
    ];

    expect(
      resolveSlot(new Date('2026-03-23T11:00:00Z'), schedules, 'Europe/London'),
    ).toBeNull();
  });

  it('agrees with generateSlots: every generated slot resolves', () => {
    const schedules: ScheduleWindow[] = [
      { dayOfWeek: 1, startTime: '10:00:00', endTime: '12:00:00', slotDurationMinutes: 30 },
      { dayOfWeek: 1, startTime: '14:00:00', endTime: '15:00:00', slotDurationMinutes: 15 },
    ];

    const slots = generateSlots({
      fromDate: '2026-03-23',
      toDate: '2026-03-30',
      timeZone: 'Europe/London',
      schedules,
      blocks: [],
      booked: [],
    });

    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      const resolved = resolveSlot(slot.startAt, schedules, 'Europe/London');
      expect(resolved).not.toBeNull();
      expect(resolved!.endAt.toISOString()).toBe(slot.endAt.toISOString());
    }
  });
});
```

The last test is the most valuable one in the file. `generateSlots` decides what
patients are *offered* and `resolveSlot` decides what the server will *accept*;
if they ever disagree, patients see slots that cannot be booked. Asserting
agreement across a DST boundary means the two functions cannot drift apart
silently.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/availability/slot-generator.spec.ts`
Expected: FAIL — `resolveSlot is not a function`.

- [ ] **Step 3: Implement `resolveSlot`**

```ts
/**
 * Resolves a requested instant to the slot it must occupy, deriving endAt from
 * the matching schedule's slot duration.
 *
 * Returns null when the instant falls outside every window for that weekday,
 * does not land exactly on a slot boundary, or would run past the window end.
 *
 * Booking calls this so the client never supplies endAt: a client-chosen end
 * could create a 5-minute appointment inside a 30-minute slot. The exclusion
 * constraint would still prevent overlap, so nothing would fail loudly, but
 * the slot grid would rot and availability would drift from reality.
 */
export function resolveSlot(
  startAt: Date,
  schedules: ScheduleWindow[],
  timeZone: string,
): Slot | null {
  const local = DateTime.fromJSDate(startAt, { zone: timeZone });
  if (!local.isValid) {
    return null;
  }

  const dayOfWeek = toDatabaseDayOfWeek(local.weekday);
  const day = local.startOf('day');

  for (const schedule of schedules) {
    if (schedule.dayOfWeek !== dayOfWeek) {
      continue;
    }

    const windowStart = day.set({ ...parseWallClock(schedule.startTime), second: 0, millisecond: 0 });
    const windowEnd = day.set({ ...parseWallClock(schedule.endTime), second: 0, millisecond: 0 });

    if (local < windowStart || local >= windowEnd) {
      continue;
    }

    // Measured in real minutes from the window start, so an instant carrying
    // seconds produces a fraction and is rejected.
    const minutesIn = local.diff(windowStart, 'minutes').minutes;
    if (!Number.isInteger(minutesIn) || minutesIn % schedule.slotDurationMinutes !== 0) {
      continue;
    }

    const slotEnd = local.plus({ minutes: schedule.slotDurationMinutes });
    if (slotEnd > windowEnd) {
      continue;
    }

    return { startAt: local.toUTC().toJSDate(), endAt: slotEnd.toUTC().toJSDate() };
  }

  return null;
}
```

`continue` rather than `return null` inside the loop: a weekday can have several
windows, and failing to match the morning one says nothing about the afternoon.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/availability/slot-generator.spec.ts`
Expected: PASS — 29 tests.

- [ ] **Step 5: Commit**

```bash
git add src/availability/slot-generator.ts src/availability/slot-generator.spec.ts
git commit -m "feat(availability): resolve a requested instant onto the doctor's slot grid"
```

---

## Task 4: The availability endpoint

**Files:**
- Create: `src/availability/dto/availability-query.dto.ts`
- Create: `src/availability/availability.repository.ts`
- Create: `src/availability/availability.service.ts`
- Create: `src/availability/availability.controller.ts`
- Create: `src/availability/availability.module.ts`
- Test: `test/availability.e2e-spec.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `SchedulesRepository.findByDoctorId` and
  `BlocksRepository.findOverlapping` (Plan 3 — note `findOverlapping` returns
  an **array**), `ConfigService` for `CLINIC_TZ`, `JwtAuthGuard` (Plan 2).
- Produces: `GET /doctors/:doctorId/availability?from=&to=`;
  `AvailabilityService.listSlots(doctorId, fromDate, toDate)`.

**Plan 5 integration point:** `AvailabilityRepository.findBookedRanges` returns
an empty array in this plan, because the `appointments` table does not exist
yet. Plan 5 Task 6 replaces its body with a call to
`AppointmentsRepository.findBookedRanges` and adds `AppointmentsModule` to this
module's imports. Do not create an appointments entity here. Keep the method
signature exactly `findBookedRanges(doctorId: string, fromAt: Date, toAt: Date): Promise<TimeRange[]>`
so Plan 5 changes one method body and nothing else.

- [ ] **Step 1: Write the query DTO**

```ts
// src/availability/dto/availability-query.dto.ts
import { Matches } from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class AvailabilityQueryDto {
  /** Clinic-local calendar date, inclusive. */
  @Matches(ISO_DATE, { message: 'from must be a date in YYYY-MM-DD form' })
  from!: string;

  @Matches(ISO_DATE, { message: 'to must be a date in YYYY-MM-DD form' })
  to!: string;
}
```

Plain `YYYY-MM-DD` strings, not `Date`. These are clinic-local calendar dates,
and parsing them into a `Date` would attach a timezone the client did not intend
— exactly the confusion this plan exists to prevent.

- [ ] **Step 2: Write the failing e2e tests**

```ts
// test/availability.e2e-spec.ts
// Fixture: a doctor with a Monday 10:00-12:00, 30-minute schedule,
// created through the API as an admin. CLINIC_TZ is Africa/Cairo in .env,
// where October is UTC+3, so 10:00 local is 07:00Z.

it('lists slots for a single day', async () => {
  const response = await request(app.getHttpServer())
    .get(`/doctors/${doctorId}/availability`)
    .query({ from: '2026-10-05', to: '2026-10-05' })
    .set('Authorization', `Bearer ${patientToken}`)
    .expect(200);

  expect(response.body).toEqual([
    { startAt: '2026-10-05T07:00:00.000Z', endAt: '2026-10-05T07:30:00.000Z' },
    { startAt: '2026-10-05T07:30:00.000Z', endAt: '2026-10-05T08:00:00.000Z' },
    { startAt: '2026-10-05T08:00:00.000Z', endAt: '2026-10-05T08:30:00.000Z' },
    { startAt: '2026-10-05T08:30:00.000Z', endAt: '2026-10-05T09:00:00.000Z' },
  ]);
});

it('returns an empty list for a day with no schedule', async () => {
  const response = await request(app.getHttpServer())
    .get(`/doctors/${doctorId}/availability`)
    .query({ from: '2026-10-06', to: '2026-10-06' }) // Tuesday
    .set('Authorization', `Bearer ${patientToken}`)
    .expect(200);

  expect(response.body).toEqual([]);
});

it('excludes slots covered by a block', async () => {
  await createBlock(doctorId, '2026-10-05T07:00:00Z', '2026-10-05T08:00:00Z');

  const response = await request(app.getHttpServer())
    .get(`/doctors/${doctorId}/availability`)
    .query({ from: '2026-10-05', to: '2026-10-05' })
    .set('Authorization', `Bearer ${patientToken}`)
    .expect(200);

  expect(response.body.map((slot: { startAt: string }) => slot.startAt)).toEqual([
    '2026-10-05T08:00:00.000Z',
    '2026-10-05T08:30:00.000Z',
  ]);
});

it('rejects a range longer than 62 days', async () => {
  const response = await request(app.getHttpServer())
    .get(`/doctors/${doctorId}/availability`)
    .query({ from: '2026-01-01', to: '2026-06-01' })
    .set('Authorization', `Bearer ${patientToken}`)
    .expect(400);

  expect(response.body.code).toBe('DATE_RANGE_TOO_LARGE');
});

it('rejects a reversed range', async () => {
  await request(app.getHttpServer())
    .get(`/doctors/${doctorId}/availability`)
    .query({ from: '2026-10-10', to: '2026-10-05' })
    .set('Authorization', `Bearer ${patientToken}`)
    .expect(400);
});

it('rejects a malformed date', async () => {
  await request(app.getHttpServer())
    .get(`/doctors/${doctorId}/availability`)
    .query({ from: '05-10-2026', to: '2026-10-05' })
    .set('Authorization', `Bearer ${patientToken}`)
    .expect(400);
});

it('returns 404 for an unknown doctor', async () => {
  await request(app.getHttpServer())
    .get('/doctors/00000000-0000-0000-0000-000000000000/availability')
    .query({ from: '2026-10-05', to: '2026-10-05' })
    .set('Authorization', `Bearer ${patientToken}`)
    .expect(404);
});

it('requires authentication', async () => {
  await request(app.getHttpServer())
    .get(`/doctors/${doctorId}/availability`)
    .query({ from: '2026-10-05', to: '2026-10-05' })
    .expect(401);
});
```

Confirm that `2026-10-05` is a Monday and that `Africa/Cairo` is UTC+3 on that
date in the container's tzdata before trusting the expected instants. If the
offset differs, adjust the fixture's weekday rather than weakening the assertion.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test:e2e -- availability`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 4: Implement the repository**

```ts
// src/availability/availability.repository.ts
import { Injectable } from '@nestjs/common';
import { BlocksRepository } from '../blocks/blocks.repository';
import { SchedulesRepository } from '../schedules/schedules.repository';
import { ScheduleWindow, TimeRange } from './slot-generator';

@Injectable()
export class AvailabilityRepository {
  constructor(
    private readonly schedules: SchedulesRepository,
    private readonly blocks: BlocksRepository,
  ) {}

  doctorExists(doctorId: string): Promise<boolean> {
    return this.schedules.doctorExists(doctorId);
  }

  /** Schedule rows structurally satisfy ScheduleWindow, so no mapping. */
  findScheduleWindows(doctorId: string): Promise<ScheduleWindow[]> {
    return this.schedules.findByDoctorId(doctorId);
  }

  async findBlockedRanges(doctorId: string, fromAt: Date, toAt: Date): Promise<TimeRange[]> {
    const blocks = await this.blocks.findOverlapping(doctorId, fromAt, toAt);
    return blocks.map((block) => ({ startAt: block.startAt, endAt: block.endAt }));
  }

  /**
   * PLAN 5 INTEGRATION POINT.
   *
   * The appointments table does not exist yet, so nothing is booked. Plan 5
   * Task 6 replaces this body with:
   *
   *   return this.appointments.findBookedRanges(doctorId, fromAt, toAt);
   *
   * and adds AppointmentsModule to AvailabilityModule's imports. The
   * signature must not change.
   */
  async findBookedRanges(
    _doctorId: string,
    _fromAt: Date,
    _toAt: Date,
  ): Promise<TimeRange[]> {
    return [];
  }
}
```

- [ ] **Step 5: Implement the service**

```ts
// src/availability/availability.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DateTime } from 'luxon';
import { BadRequestError } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-code.enum';
import { AvailabilityRepository } from './availability.repository';
import { generateSlots, MAX_AVAILABILITY_RANGE_DAYS, Slot } from './slot-generator';

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly repository: AvailabilityRepository,
    private readonly config: ConfigService,
  ) {}

  async listSlots(doctorId: string, fromDate: string, toDate: string): Promise<Slot[]> {
    const timeZone = this.config.getOrThrow<string>('CLINIC_TZ');

    const first = DateTime.fromISO(fromDate, { zone: timeZone }).startOf('day');
    const last = DateTime.fromISO(toDate, { zone: timeZone }).startOf('day');

    if (!first.isValid || !last.isValid) {
      throw new BadRequestError(
        ErrorCode.ValidationFailed,
        'from and to must be valid calendar dates.',
      );
    }

    if (last < first) {
      throw new BadRequestError(ErrorCode.ValidationFailed, 'to must not precede from.');
    }

    // Inclusive on both ends, so a single day is a range of 1.
    const days = last.diff(first, 'days').days + 1;
    if (days > MAX_AVAILABILITY_RANGE_DAYS) {
      throw new BadRequestError(
        ErrorCode.DateRangeTooLarge,
        `Availability can be listed for at most ${MAX_AVAILABILITY_RANGE_DAYS} days at a time.`,
      );
    }

    if (!(await this.repository.doctorExists(doctorId))) {
      throw new NotFoundException('Doctor not found');
    }

    // The window handed to the range queries must cover the whole local range
    // in UTC, including the exclusive end of the final day.
    const fromAt = first.toUTC().toJSDate();
    const toAt = last.plus({ days: 1 }).toUTC().toJSDate();

    const [schedules, blocks, booked] = await Promise.all([
      this.repository.findScheduleWindows(doctorId),
      this.repository.findBlockedRanges(doctorId, fromAt, toAt),
      this.repository.findBookedRanges(doctorId, fromAt, toAt),
    ]);

    return generateSlots({ fromDate, toDate, timeZone, schedules, blocks, booked });
  }
}
```

The `last.plus({ days: 1 })` is deliberate. Querying only to the *start* of the
final day would miss every block and booking on it, and the last day of any
range would wrongly appear fully available.

- [ ] **Step 6: Implement the controller and module**

```ts
// src/availability/availability.controller.ts
import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { AvailabilityQueryDto } from './dto/availability-query.dto';
import { AvailabilityService } from './availability.service';

@Controller('doctors/:doctorId/availability')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  /**
   * Readable by any authenticated user: patients need it to book, and it
   * exposes no personal data -- only free times.
   */
  @Get()
  async list(
    @Param('doctorId', ParseUUIDPipe) doctorId: string,
    @Query() query: AvailabilityQueryDto,
  ) {
    const slots = await this.availability.listSlots(doctorId, query.from, query.to);
    return slots.map((slot) => ({
      startAt: slot.startAt.toISOString(),
      endAt: slot.endAt.toISOString(),
    }));
  }
}
```

```ts
// src/availability/availability.module.ts
import { Module } from '@nestjs/common';
import { BlocksModule } from '../blocks/blocks.module';
import { SchedulesModule } from '../schedules/schedules.module';
import { AvailabilityController } from './availability.controller';
import { AvailabilityRepository } from './availability.repository';
import { AvailabilityService } from './availability.service';

@Module({
  imports: [SchedulesModule, BlocksModule],
  controllers: [AvailabilityController],
  providers: [AvailabilityRepository, AvailabilityService],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
```

Add `AvailabilityModule` to `src/app.module.ts` imports.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npm run test:e2e -- availability
npm test
```

Expected: all availability e2e tests pass; 29 slot-generator unit tests pass.

- [ ] **Step 8: Sanity-check the endpoint by hand**

```bash
docker compose up -d
# Log in as a patient and export TOKEN, then:
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/doctors/$DOCTOR_ID/availability?from=2026-10-05&to=2026-10-05" | jq
```

Expected: four slots at 07:00Z, 07:30Z, 08:00Z, 08:30Z for a Monday
10:00–12:00 Cairo schedule. If the instants are three hours out, `CLINIC_TZ` is
not being read — check `.env` rather than adjusting the generator.

- [ ] **Step 9: Commit**

```bash
git add src/availability src/app.module.ts test/availability.e2e-spec.ts
git commit -m "feat(availability): add doctor availability endpoint with range cap"
```

---

## Definition of Done

- [ ] `npm test` passes 29 slot-generator unit tests.
- [ ] `npm run test:e2e -- availability` passes.
- [ ] The DST tests assert different UTC instants for 2026-03-23 and
      2026-03-30, and for 2026-10-19 and 2026-10-26.
- [ ] The agreement test passes: every slot from `generateSlots` resolves
      through `resolveSlot` to the same `endAt`.
- [ ] A block touching a slot boundary does not remove that slot.
- [ ] A 63-day range returns 400 `DATE_RANGE_TOO_LARGE`; a 62-day range succeeds.
- [ ] `grep -n "new Date()" src/availability/slot-generator.ts` returns nothing.
- [ ] `grep -rn "Africa/Cairo" src/availability src/schedules src/blocks`
      returns nothing — the zone comes from configuration only. The config
      validator's example error message and `env.validation.spec.ts` fixture
      are exempt.
- [ ] `findBookedRanges` still returns `[]` and carries its
      `PLAN 5 INTEGRATION POINT` comment.

---

## Next

Plan 5 (Booking) consumes `resolveSlot` to derive `endAt` and reject off-grid
requests, and replaces `findBookedRanges` in Task 6. Plan 7 (Waiting list) calls
`resolveSlot` to validate a queue request and to store `slotEndAt`.
