# Doctor Monthly Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `GET /doctors/:doctorId/analytics?year=&month=` returns total
appointments, cancellation rate, peak booking hours and average schedule
utilization for one doctor and one clinic-local month, with every number
computed by PostgreSQL in a single round trip.

**Architecture:** Controller → service → repository, per `docs/ARCHITECTURE.md`.
The repository holds one raw SQL statement assembled from eight CTEs
(`params`, `stats`, `hourly`, `peak`, `days`, `windows`, `blocked`, `capacity`),
each with a single job. The service adds the 404 for an unknown doctor and
nothing else. Authorization is the existing `DoctorOwnershipGuard`. The plan also
adds the `(doctor_id, start_at)` index the query needs, with `EXPLAIN ANALYZE`
evidence before and after.

**Tech Stack:** NestJS 11, TypeScript 5.7, TypeORM (raw `DataSource.query`),
PostgreSQL 16 (`range_agg`, multirange types, `AT TIME ZONE`), Luxon (tests
only), Jest 30, Supertest.

## Global Constraints

- **Every metric is computed in PostgreSQL.** No aggregation in JavaScript.
  `repository.find()` over appointments must not appear anywhere in the
  analytics path. (`docs/FEATURES/Analytics.md`)
- **One round trip.** The four metrics come back as four already-computed
  scalars from a single `DataSource.query` call.
- **Month boundaries are clinic-local, not UTC.** The range is
  `[first day 00:00 CLINIC_TZ, first day of next month 00:00 CLINIC_TZ)`
  expressed as `timestamptz`. (`docs/DECISIONS.md` #9)
- **`EXTRACT(DOW)` returns 0 for Sunday.** `schedules.day_of_week` uses the same
  convention and the capacity join depends on it. (`docs/DATABASE.md`,
  `docs/DECISIONS.md` #12)
- **Blocks are merged with `range_agg` into one multirange before subtraction**,
  so no minute can be subtracted twice. `blocks_no_overlap` (Plan 3) already
  makes overlapping blocks unstorable; the merge keeps the query correct without
  depending on that. (`docs/DECISIONS.md` #12, #18)
- **`range_agg` and multirange types require PostgreSQL 14+.** Compose pins
  PostgreSQL 16. (`docs/PLANS/01-foundation.md` Global Constraints)
- **Every division is guarded with `NULLIF` and wrapped in `COALESCE(..., 0)`.**
  `NULLIF` prevents the error; `COALESCE` is what turns the result into the
  documented `0`.
- Cancelled appointments count toward total appointments but never toward booked
  minutes. The two metrics deliberately use different filters.
- Peak hours returns **all** tied hours, ascending.
- `synchronize: true` is forbidden in every environment, including tests. All
  schema changes go through migrations. (`docs/STACK.md`)
- No service reads the current time via `new Date()`. Time comes from the
  injected `Clock`. (Nothing in this plan needs the current time; the analytics
  month is always supplied by the caller.)
- Error bodies are `{ statusCode, code, message }` where `code` is a member of
  `ErrorCode`. (`docs/API.md`)
- Commit messages follow `docs/DEVELOPMENT.md`, e.g.
  `feat(analytics): add doctor monthly analytics endpoint`.

## What earlier plans provide

Consume these exactly as specified in `docs/PLANS/00-interfaces.md`. Do not
redefine them.

- **Plan 1:** `AppConfigModule` (global `ConfigService`, `CLINIC_TZ` validated as
  a real IANA zone), `DatabaseModule`, `npm run migration:run` /
  `migration:revert`, `AppException` + `ErrorCode`, `AllExceptionsFilter`,
  `docker compose` PostgreSQL 16, the e2e harness at `test/setup-db.ts` with
  `maxWorkers: 1`.
- **Plan 2:** `JwtAuthGuard` (global, opt out with `@Public()`),
  `DoctorOwnershipGuard` at
  `src/auth/guards/doctor-ownership.guard.ts`, `JwtPayload`, `AuthUser`,
  `UserRole`, and the `users` / `doctors` / `patients` tables.
- **Plan 3:** the `schedules` table (`doctor_id`, `day_of_week` 0 = Sunday,
  `start_time`, `end_time`, `slot_duration_minutes`) and the `blocks` table
  (`doctor_id`, `start_at`, `end_at`, `reason`).
- **Plan 5:** the `appointments` table (`doctor_id`, `patient_id`, `start_at`,
  `end_at`, `status`, `created_from`, `cancelled_at`) and the partial GiST
  exclusion constraints `appointments_no_overlap` and
  `appointments_patient_no_overlap`.

---

## File Structure

**Created by this plan:**

```text
src/analytics/
  analytics.sql.ts                        the one query, as an exported const
  analytics.repository.ts                 executes it, maps the single row
  analytics.service.ts                    doctor-exists check, nothing else
  analytics.controller.ts                 GET /doctors/:doctorId/analytics
  analytics.module.ts
  doctor-monthly-analytics.interface.ts   DoctorMonthlyAnalytics
  dto/
    get-doctor-analytics-query.dto.ts     year + month validation
  analytics.service.spec.ts               unit, mocked repository
  analytics.architecture.spec.ts          proves no JS aggregation crept in

src/database/migrations/
  1757462400000-AddAppointmentsDoctorStartAtIndex.ts

scripts/
  analytics-perf-seed.sql                 scratch dataset for EXPLAIN ANALYZE
  analytics-explain.sql                   EXPLAIN (ANALYZE, BUFFERS) runner
  analytics-perf-cleanup.sql              removes the scratch dataset

test/
  fixtures/analytics.fixture.ts           row builders + truncation helper
  analytics-fixture.e2e-spec.ts           proves the fixture helper is honest
  analytics-repository.e2e-spec.ts        the metric arithmetic, against real PG
  analytics.e2e-spec.ts                   HTTP contract + authorization

docs/EVIDENCE/
  analytics-index.md                      EXPLAIN ANALYZE before/after
```

**Modified:** `src/app.module.ts` (register `AnalyticsModule`),
`docs/PLANS/00-interfaces.md` (record `doctorExists`, added in Task 4).

The SQL lives in its own file because it is the largest and most reviewed
artefact in the feature; keeping it out of the repository class means a diff to
the query is a diff to one file. `doctor-monthly-analytics.interface.ts` sits
beside the repository rather than in `dto/` because it is a repository return
type, not an HTTP payload — and the HTTP response is that same object, so no
response DTO exists. `dto/` holds only the query-string DTO, which is the only
thing that needs validating.

---

## Query Walkthrough

Read this before Task 2. You will be asked to explain this query line by line.

The statement takes four parameters — `$1` doctor id, `$2` year, `$3` month,
`$4` the IANA timezone name from `CLINIC_TZ` — and returns exactly one row.

**`params`** turns the year/month pair into two `timestamptz` boundaries.
`make_date(2026, 2, 1)` gives a naive date; `::timestamp AT TIME ZONE 'Africa/Cairo'`
reads that naive value **as** clinic wall-clock time and returns the UTC instant
it corresponds to. Adding `INTERVAL '1 month'` before the conversion gives the
exclusive upper bound. `AT TIME ZONE` runs in both directions and the direction
is decided by the input type: applied to a naive `timestamp` it produces a
`timestamptz`; applied to a `timestamptz` it produces the naive local
`timestamp`. Both directions appear in this query. Confusing them is the
standard way this kind of query goes quietly wrong — the answer still looks
plausible, it is just shifted.

**`stats`** scans the doctor's appointments once and produces three numbers with
`FILTER` clauses instead of three separate scans. `total` counts every row
regardless of status. `cancelled` counts only `CANCELLED`. `booked_minutes` sums
durations only for `CONFIRMED`. That the same scan produces both a
status-agnostic count and a status-filtered sum is the point: the two metrics
deliberately disagree about cancelled rows, and putting them side by side makes
that visible. Because the `WHERE` clause is an inner join against `params`, a
doctor with no appointments produces zero input rows, and an aggregate over zero
rows still returns exactly one row — `0, 0, 0`.

**`hourly`** groups `CONFIRMED` appointments by
`EXTRACT(HOUR FROM start_at AT TIME ZONE tz)`. Here `AT TIME ZONE` is applied to
a `timestamptz`, so it runs the other way and yields local wall-clock time.
Grouping on the local hour is what makes "the 10am slot is the busiest" a true
statement about the clinic rather than about UTC. Only confirmed rows are
counted, because a cancelled appointment did not actually occupy that hour.

**`peak`** selects every hour whose count equals `(SELECT MAX(bookings) FROM hourly)`.
Comparing against `MAX` rather than `ORDER BY bookings DESC LIMIT 1` is exactly
what returns all tied hours. `array_agg(hour ORDER BY hour)` sorts them
ascending. When `hourly` is empty, `MAX` is `NULL`, `bookings = NULL` is never
true, and `array_agg` over zero rows returns `NULL` — handled by a `COALESCE` in
the final select.

**`days`** produces one row per calendar day of the clinic-local month.
`(month_start AT TIME ZONE tz)::date` converts the boundary back to a local date
— the first of the month — and the day count is the difference between the two
local dates. `generate_series(0, n - 1)` then gives day offsets, and `date + int`
gives dates. Integer series rather than a timestamp series keeps the function
overload unambiguous and the arithmetic obvious.

**`windows`** is where capacity comes from. Capacity does not exist as rows
anywhere: it is a recurring weekly pattern that has to be expanded over a
concrete month. Each day joins to the doctor's schedule rows on
`s.day_of_week = EXTRACT(DOW FROM d.day)::int`, and each match becomes one
concrete `tstzrange` for that day. **`EXTRACT(DOW)` returns 0 for Sunday**, so
`schedules.day_of_week` must use 0 = Sunday; ISO numbering (1 = Monday) would
shift every schedule by one day while still looking internally consistent. The
bound is `'[)'`, half-open, matching every other range in the schema. Summing
window durations rather than generating individual slots gives the same ratio
with far less to reason about, and avoids a nested `generate_series`.

A DST note: on a transition day, `(day + start_time) AT TIME ZONE tz` and
`(day + end_time) AT TIME ZONE tz` are an hour closer together or further apart
than the wall-clock difference suggests. That is correct — the doctor really did
work one hour less that day.

**`blocked`** merges every block overlapping the month into a **single
multirange** with `range_agg`. If each block were intersected with a working
window separately, any time two of them shared would be subtracted twice; a
window can then go negative and total utilization can exceed 100% or turn
negative. `blocks_no_overlap` (Plan 3) means a doctor cannot store two blocks
that share a minute, so the merge is not the only thing standing between the
query and that bug — but it makes the arithmetic correct by construction rather
than by trusting a constraint in another table's migration, and it costs one
function call. `COALESCE(..., '{}'::tstzmultirange)` is there because
`range_agg` over zero rows returns `NULL`, and a `NULL` multirange would poison
the subtraction downstream.

**`capacity`** subtracts, per window, with one operator:
`tstzmultirange(w.win) - bl.ranges`. Multirange difference is set difference, so
it cannot remove more time than the window contains — the denominator is
structurally incapable of going negative. `unnest` expands whatever survives
into concrete ranges and the durations are summed. Three edge cases fall out for
free: a partially overlapping block subtracts only the overlapping portion; a
block outside working hours subtracts nothing; a fully blocked window
contributes zero rows and therefore zero minutes. If the doctor has no schedule
that month, `windows` is empty, the sum is `NULL`, and `COALESCE` makes it `0`.

**Final select.** `stats`, `peak` and `capacity` are each single-row aggregates,
so the three-way cross join produces exactly one row — always, even for a doctor
id that does not exist. Both percentages divide by `NULLIF(x, 0)`, which turns a
zero denominator into `NULL` instead of an error, and then `COALESCE(..., 0)`
turns that `NULL` into the documented zero. `NULLIF` alone would return `NULL`,
not `0`; `docs/FEATURES/Analytics.md` shows the division guard without the outer
`COALESCE`, and its prose ("returns zeros") is the behaviour we implement.

Note one definitional artefact worth being able to state out loud: booked
minutes are summed over confirmed appointments in the month whether or not they
fall inside a current schedule window. If a doctor's schedule shrank after
appointments were booked, utilization can exceed 100%. That is a property of the
definition in `docs/DECISIONS.md` #9, not a bug in the query, and the fix would
be to intersect booked time with the capacity multirange as well.

---

## Task 1: Analytics test fixtures

The metric tests only mean something if their fixtures are exactly what the
comments say they are. This task builds the row builders and then proves the
timezone arithmetic every later comment relies on.

**Files:**
- Create: `test/fixtures/analytics.fixture.ts`
- Test: `test/analytics-fixture.e2e-spec.ts`

**Interfaces:**
- Consumes: the `users`, `doctors`, `patients`, `schedules`, `blocks`,
  `appointments` tables from Plans 2, 3 and 5; the e2e harness from Plan 1.
- Produces:
  ```ts
  resetAnalyticsData(ds: DataSource): Promise<void>
  createDoctor(ds: DataSource, label: string): Promise<string>   // doctors.id
  createPatient(ds: DataSource, label: string): Promise<string>  // patients.id
  createSchedule(ds: DataSource, input: ScheduleInput): Promise<void>
  createBlock(ds: DataSource, input: BlockInput): Promise<void>
  createAppointment(ds: DataSource, input: AppointmentInput): Promise<void>
  userIdForDoctor(ds: DataSource, doctorId: string): Promise<string>
  userIdForPatient(ds: DataSource, patientId: string): Promise<string>
  ```
  Task 2 uses the builders; Task 4 additionally uses `userIdForDoctor` and
  `userIdForPatient` to sign tokens.

- [ ] **Step 1: Write the fixture helper**

Create `test/fixtures/analytics.fixture.ts`:

```ts
import { DataSource } from 'typeorm';

export interface ScheduleInput {
  doctorId: string;
  /** 0 = Sunday .. 6 = Saturday, matching EXTRACT(DOW). */
  dayOfWeek: number;
  startTime: string; // 'HH:mm:ss'
  endTime: string; // 'HH:mm:ss'
  slotDurationMinutes: number;
}

export interface BlockInput {
  doctorId: string;
  startAt: string; // ISO 8601 UTC
  endAt: string; // ISO 8601 UTC
  reason: string;
}

export interface AppointmentInput {
  doctorId: string;
  patientId: string;
  startAt: string; // ISO 8601 UTC
  endAt: string; // ISO 8601 UTC
  status?: 'CONFIRMED' | 'CANCELLED';
}

/**
 * Truncating `users` cascades through doctors, patients, schedules, blocks,
 * appointments, notifications and waiting_list via their foreign keys, so this
 * is the whole reset in one statement.
 *
 * Safe because the e2e suite runs with maxWorkers: 1 against a disposable
 * database (docs/PLANS/01-foundation.md, Task 6).
 */
export async function resetAnalyticsData(ds: DataSource): Promise<void> {
  await ds.query('TRUNCATE users CASCADE');
}

export async function createDoctor(ds: DataSource, label: string): Promise<string> {
  const [user] = await ds.query(
    `INSERT INTO users (first_name, last_name, email, password_hash, role)
     VALUES ($1, 'Doctor', $2, 'not-a-real-hash', 'DOCTOR')
     RETURNING id`,
    [label, `${label}.doctor@analytics.test`],
  );

  const [doctor] = await ds.query(
    `INSERT INTO doctors (user_id, specialization)
     VALUES ($1, 'General Practice')
     RETURNING id`,
    [user.id],
  );

  return doctor.id;
}

export async function createPatient(ds: DataSource, label: string): Promise<string> {
  const [user] = await ds.query(
    `INSERT INTO users (first_name, last_name, email, password_hash, role)
     VALUES ($1, 'Patient', $2, 'not-a-real-hash', 'PATIENT')
     RETURNING id`,
    [label, `${label}.patient@analytics.test`],
  );

  const [patient] = await ds.query(
    `INSERT INTO patients (user_id) VALUES ($1) RETURNING id`,
    [user.id],
  );

  return patient.id;
}

export async function createSchedule(ds: DataSource, input: ScheduleInput): Promise<void> {
  await ds.query(
    `INSERT INTO schedules (doctor_id, day_of_week, start_time, end_time, slot_duration_minutes)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.doctorId,
      input.dayOfWeek,
      input.startTime,
      input.endTime,
      input.slotDurationMinutes,
    ],
  );
}

export async function createBlock(ds: DataSource, input: BlockInput): Promise<void> {
  await ds.query(
    `INSERT INTO blocks (doctor_id, start_at, end_at, reason) VALUES ($1, $2, $3, $4)`,
    [input.doctorId, input.startAt, input.endAt, input.reason],
  );
}

export async function createAppointment(
  ds: DataSource,
  input: AppointmentInput,
): Promise<void> {
  const status = input.status ?? 'CONFIRMED';

  await ds.query(
    `INSERT INTO appointments (doctor_id, patient_id, start_at, end_at, status, cancelled_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.doctorId,
      input.patientId,
      input.startAt,
      input.endAt,
      status,
      status === 'CANCELLED' ? input.startAt : null,
    ],
  );
}

export async function userIdForDoctor(ds: DataSource, doctorId: string): Promise<string> {
  const [row] = await ds.query('SELECT user_id FROM doctors WHERE id = $1', [doctorId]);
  return row.user_id;
}

export async function userIdForPatient(ds: DataSource, patientId: string): Promise<string> {
  const [row] = await ds.query('SELECT user_id FROM patients WHERE id = $1', [patientId]);
  return row.user_id;
}
```

Rows are inserted with raw SQL rather than through the booking endpoint on
purpose. Booking rejects anything off the slot grid, and several fixtures below
deliberately place appointments at 00:30 local to test month bucketing.

- [ ] **Step 2: Write the fixture verification test**

Create `test/analytics-fixture.e2e-spec.ts`:

```ts
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
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
docker compose --profile test up -d postgres-test
npx jest --config test/jest-e2e.json test/analytics-fixture.e2e-spec.ts
```

Expected: FAIL — `Cannot find module './fixtures/analytics.fixture'` before
Step 1 is applied; after Step 1 it should pass. If it fails on
`runs with CLINIC_TZ = Africa/Cairo`, set `CLINIC_TZ=Africa/Cairo` in `.env`
before continuing — every expected value in Task 2 assumes it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest --config test/jest-e2e.json test/analytics-fixture.e2e-spec.ts`
Expected: PASS — 9 tests (the `it.each` block counts as four).

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/analytics.fixture.ts test/analytics-fixture.e2e-spec.ts
git commit -m "test(analytics): add fixture helpers and pin clinic timezone arithmetic"
```

---

## Task 2: The analytics query and repository

One statement, one round trip, four scalars. Every test below states its
arithmetic in a comment so the expected number can be recomputed by hand.

**Files:**
- Create: `src/analytics/doctor-monthly-analytics.interface.ts`
- Create: `src/analytics/analytics.sql.ts`
- Create: `src/analytics/analytics.repository.ts`
- Create: `src/analytics/analytics.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/analytics-repository.e2e-spec.ts`

**Interfaces:**
- Consumes: `resetAnalyticsData`, `createDoctor`, `createPatient`,
  `createSchedule`, `createBlock`, `createAppointment` (Task 1);
  `ConfigService` and `CLINIC_TZ` (Plan 1); the `appointments`, `schedules` and
  `blocks` tables (Plans 3 and 5).
- Produces:
  ```ts
  // src/analytics/doctor-monthly-analytics.interface.ts
  export interface DoctorMonthlyAnalytics {
    totalAppointments: number;
    cancellationRate: number;   // percentage, 2 decimal places
    peakHours: number[];        // clinic-local hours, ascending, all ties
    utilizationRate: number;    // percentage, 2 decimal places
  }

  // src/analytics/analytics.sql.ts
  export const DOCTOR_MONTHLY_ANALYTICS_SQL: string;

  // src/analytics/analytics.repository.ts
  class AnalyticsRepository {
    getDoctorMonthlyAnalytics(
      doctorId: string,
      year: number,
      month: number,     // 1-12
    ): Promise<DoctorMonthlyAnalytics>;
  }

  // src/analytics/analytics.module.ts
  export class AnalyticsModule {}
  ```
  Task 4 adds `AnalyticsService`, `AnalyticsController` and
  `AnalyticsRepository.doctorExists` to this module.

- [ ] **Step 1: Write the return-type interface**

Create `src/analytics/doctor-monthly-analytics.interface.ts`:

```ts
/**
 * Monthly analytics for one doctor. Every field is computed by PostgreSQL;
 * nothing here is derived in JavaScript.
 *
 * Contract: docs/PLANS/00-interfaces.md, "AnalyticsRepository (Plan 8)".
 */
export interface DoctorMonthlyAnalytics {
  totalAppointments: number;
  /** Percentage, two decimal places. 0 when there are no appointments. */
  cancellationRate: number;
  /** Clinic-local hours, ascending. All tied hours, empty when there is no data. */
  peakHours: number[];
  /** Percentage, two decimal places. 0 when there is no schedule that month. */
  utilizationRate: number;
}
```

- [ ] **Step 2: Write the failing test — counts, rates, hours and utilization together**

Create `test/analytics-repository.e2e-spec.ts`:

```ts
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest --config test/jest-e2e.json test/analytics-repository.e2e-spec.ts`
Expected: FAIL — `Cannot find module '../src/analytics/analytics.repository'`.

- [ ] **Step 4: Write the SQL**

Create `src/analytics/analytics.sql.ts`:

```ts
/**
 * Doctor monthly analytics, computed entirely inside PostgreSQL.
 *
 * Parameters:
 *   $1  doctor id       uuid
 *   $2  year            int
 *   $3  month           int, 1-12
 *   $4  clinic timezone IANA name, e.g. 'Africa/Cairo'
 *
 * Always returns exactly one row: `stats`, `peak` and `capacity` are each
 * single-row aggregates, so the three-way cross join at the bottom cannot
 * produce zero rows even for a doctor id that does not exist.
 *
 * Requires PostgreSQL 14 or newer for `range_agg`, multirange types and
 * `unnest(anymultirange)`. Compose pins 16 (docs/INFRASTRUCTURE/Deployment.md).
 *
 * Walkthrough: docs/PLANS/08-analytics.md, "Query Walkthrough".
 */
export const DOCTOR_MONTHLY_ANALYTICS_SQL = `
WITH params AS (
  -- Month boundaries in CLINIC-LOCAL time, converted to UTC instants.
  -- AT TIME ZONE applied to a naive timestamp reads it AS clinic time and
  -- returns a timestamptz. Using UTC boundaries here would mis-bucket every
  -- appointment near local midnight on the first and last day of the month.
  SELECT
    $1::uuid AS doctor_id,
    $4::text AS tz,
    (make_date($2::int, $3::int, 1)::timestamp AT TIME ZONE $4::text) AS month_start,
    ((make_date($2::int, $3::int, 1) + INTERVAL '1 month')::timestamp AT TIME ZONE $4::text) AS month_end
),

stats AS (
  -- One scan, three numbers. FILTER is what lets total count every status
  -- while booked_minutes counts only CONFIRMED rows.
  SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE a.status = 'CANCELLED') AS cancelled,
    COALESCE(
      SUM(EXTRACT(EPOCH FROM (a.end_at - a.start_at)) / 60)
        FILTER (WHERE a.status = 'CONFIRMED'),
      0
    ) AS booked_minutes
  FROM appointments a, params p
  WHERE a.doctor_id = p.doctor_id
    AND a.start_at >= p.month_start
    AND a.start_at <  p.month_end
),

hourly AS (
  -- AT TIME ZONE applied to a timestamptz runs the other way and yields the
  -- naive local time, so this groups by the clinic's hour, not UTC's.
  SELECT
    EXTRACT(HOUR FROM (a.start_at AT TIME ZONE p.tz))::int AS hour,
    COUNT(*) AS bookings
  FROM appointments a, params p
  WHERE a.doctor_id = p.doctor_id
    AND a.start_at >= p.month_start
    AND a.start_at <  p.month_end
    AND a.status = 'CONFIRMED'
  GROUP BY 1
),

peak AS (
  -- Comparing against MAX, rather than ORDER BY ... LIMIT 1, is what returns
  -- every tied hour instead of an arbitrary one of them.
  SELECT array_agg(h.hour ORDER BY h.hour) AS peak_hours
  FROM hourly h
  WHERE h.bookings = (SELECT MAX(h2.bookings) FROM hourly h2)
),

days AS (
  -- One row per calendar day of the clinic-local month. An integer series
  -- keeps the generate_series overload unambiguous and the arithmetic plain:
  -- day 0 through day (days-in-month - 1).
  SELECT (p.month_start AT TIME ZONE p.tz)::date + offset_days AS day
  FROM params p,
       generate_series(
         0,
         ((p.month_end AT TIME ZONE p.tz)::date - (p.month_start AT TIME ZONE p.tz)::date) - 1
       ) AS offset_days
),

windows AS (
  -- Capacity has no rows of its own: it is a weekly pattern expanded over a
  -- concrete month. Each schedule row becomes one UTC window per matching day.
  -- EXTRACT(DOW) returns 0 for Sunday, which is why schedules.day_of_week must
  -- use 0 = Sunday (docs/DATABASE.md). Half-open '[)' bounds, as everywhere.
  SELECT tstzrange(
           (d.day + s.start_time) AT TIME ZONE p.tz,
           (d.day + s.end_time)   AT TIME ZONE p.tz,
           '[)'
         ) AS win
  FROM days d
  CROSS JOIN params p
  JOIN schedules s
    ON s.doctor_id = p.doctor_id
   AND s.day_of_week = EXTRACT(DOW FROM d.day)::int
),

blocked AS (
  -- Every block touching the month, merged into ONE multirange before it is
  -- subtracted. Subtracting block by block would take any shared minute off
  -- twice and utilization could exceed 100% or go negative. blocks_no_overlap
  -- makes such a pair unstorable; the merge means the query does not depend on
  -- that. range_agg over zero rows returns NULL, hence the COALESCE.
  SELECT COALESCE(
           range_agg(tstzrange(b.start_at, b.end_at, '[)')),
           '{}'::tstzmultirange
         ) AS ranges
  FROM blocks b, params p
  WHERE b.doctor_id = p.doctor_id
    AND b.start_at < p.month_end
    AND b.end_at   > p.month_start
),

capacity AS (
  -- Multirange difference is set difference, so it can never remove more time
  -- than the window contains. A partial overlap leaves the rest of the window,
  -- a block outside working hours removes nothing, and a fully blocked window
  -- yields zero rows and therefore zero minutes.
  SELECT COALESCE(
           SUM(EXTRACT(EPOCH FROM (upper(free.part) - lower(free.part))) / 60),
           0
         ) AS available_minutes
  FROM windows w
  CROSS JOIN blocked bl
  CROSS JOIN LATERAL unnest(tstzmultirange(w.win) - bl.ranges) AS free(part)
)

-- NULLIF turns a zero denominator into NULL instead of an error; COALESCE is
-- what turns that NULL into the documented 0.
SELECT
  s.total::int                                                          AS total_appointments,
  COALESCE(ROUND(100.0 * s.cancelled / NULLIF(s.total, 0), 2), 0)       AS cancellation_rate,
  COALESCE(pk.peak_hours, '{}'::int[])                                  AS peak_hours,
  COALESCE(ROUND(100.0 * s.booked_minutes / NULLIF(c.available_minutes, 0), 2), 0)
                                                                        AS utilization_rate
FROM stats s, peak pk, capacity c
`;
```

- [ ] **Step 5: Write the repository**

Create `src/analytics/analytics.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DOCTOR_MONTHLY_ANALYTICS_SQL } from './analytics.sql';
import { DoctorMonthlyAnalytics } from './doctor-monthly-analytics.interface';

/**
 * Shape of the single row the analytics query returns.
 *
 * `numeric` columns arrive from node-postgres as strings, because a numeric can
 * hold values a JavaScript number cannot. Both percentages are bounded
 * two-decimal values, so Number() is safe here — and it is the only arithmetic
 * this class is allowed to do.
 */
interface AnalyticsRow {
  total_appointments: number;
  cancellation_rate: string;
  peak_hours: number[];
  utilization_rate: string;
}

@Injectable()
export class AnalyticsRepository {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  /**
   * One statement, one round trip, four already-computed scalars.
   *
   * `month` is 1-12. The clinic timezone is a query parameter rather than a
   * service argument because it is part of the query's contract, not a business
   * decision the caller gets to make.
   */
  async getDoctorMonthlyAnalytics(
    doctorId: string,
    year: number,
    month: number,
  ): Promise<DoctorMonthlyAnalytics> {
    const timeZone = this.config.getOrThrow<string>('CLINIC_TZ');

    const rows: AnalyticsRow[] = await this.dataSource.query(DOCTOR_MONTHLY_ANALYTICS_SQL, [
      doctorId,
      year,
      month,
      timeZone,
    ]);

    // The query cross-joins three single-row aggregates, so there is always
    // exactly one row, even when the doctor has no data at all.
    const row = rows[0];

    return {
      totalAppointments: row.total_appointments,
      cancellationRate: Number(row.cancellation_rate),
      peakHours: row.peak_hours,
      utilizationRate: Number(row.utilization_rate),
    };
  }
}
```

- [ ] **Step 6: Create the module and register it**

Create `src/analytics/analytics.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AnalyticsRepository } from './analytics.repository';

// No TypeOrmModule.forFeature: the repository executes raw SQL through the
// injected DataSource and owns no entity.
@Module({
  providers: [AnalyticsRepository],
  exports: [AnalyticsRepository],
})
export class AnalyticsModule {}
```

Add `AnalyticsModule` to the `imports` array in `src/app.module.ts`, keeping the
existing entries:

```ts
import { AnalyticsModule } from './analytics/analytics.module';

// ...
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    ClockModule,
    HealthModule,
    // ... the feature modules added by Plans 2-7 ...
    AnalyticsModule,
  ],
})
export class AppModule {}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx jest --config test/jest-e2e.json test/analytics-repository.e2e-spec.ts`
Expected: PASS — 13 tests.

If `utilizationRate` comes back as `25` in the block-subtraction test, the
partial block on 15 February is not being subtracted at all; if it comes back as
`37.5`, it is removing the whole window instead of the hour it covers. Either way
check that `capacity` subtracts `bl.ranges` from `tstzmultirange(w.win)` and sums
what survives, rather than treating any intersection as a fully blocked window.

If the boundary tests report January 1 / February 3 / March 0, the month
boundaries are being computed in UTC — check that `params` applies
`AT TIME ZONE` to a naive `timestamp`, not to a `timestamptz`.

- [ ] **Step 8: Commit**

```bash
git add src/analytics src/app.module.ts test/analytics-repository.e2e-spec.ts
git commit -m "feat(analytics): compute doctor monthly analytics in one SQL query"
```

---

## Task 3: The `(doctor_id, start_at)` index, with measurements

The `stats` and `hourly` CTEs read the doctor's appointments for a month
**including cancelled rows**, so they cannot use the partial GiST index created
by `appointments_no_overlap` (`WHERE status = 'CONFIRMED'`). This is the index
that exists for that query, and `docs/DATABASE.md` requires an index to be
justified by a measurement.

**Files:**
- Create: `src/database/migrations/1757462400000-AddAppointmentsDoctorStartAtIndex.ts`
- Create: `scripts/analytics-perf-seed.sql`
- Create: `scripts/analytics-explain.sql`
- Create: `scripts/analytics-perf-cleanup.sql`
- Create: `docs/EVIDENCE/analytics-index.md`

**Interfaces:**
- Consumes: `DOCTOR_MONTHLY_ANALYTICS_SQL` (Task 2), `npm run migration:run` /
  `migration:revert` (Plan 1), the `appointments` / `schedules` / `blocks`
  tables.
- Produces: index `appointments_doctor_start_at_idx` on
  `appointments (doctor_id, start_at)`; `docs/EVIDENCE/analytics-index.md`
  holding both plans. The README quotes from that file.

- [ ] **Step 1: Write the migration**

Create `src/database/migrations/1757462400000-AddAppointmentsDoctorStartAtIndex.ts`:

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAppointmentsDoctorStartAtIndex1757462400000 implements MigrationInterface {
  name = 'AddAppointmentsDoctorStartAtIndex1757462400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The monthly analytics query counts CANCELLED rows as well as CONFIRMED
    // ones, so it cannot use the partial GiST index that the
    // appointments_no_overlap exclusion constraint creates
    // (WHERE status = 'CONFIRMED'). This non-partial btree serves the
    // (doctor_id, start_at range) scan in the `stats` and `hourly` CTEs.
    //
    // Not CONCURRENTLY: TypeORM runs each migration inside a transaction and
    // CREATE INDEX CONCURRENTLY cannot run in one. On a live production table
    // this index would be created out of band instead.
    await queryRunner.query(
      `CREATE INDEX appointments_doctor_start_at_idx ON appointments (doctor_id, start_at)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX appointments_doctor_start_at_idx`);
  }
}
```

If a migration from Plans 2-7 already carries a timestamp later than
`1757462400000`, rename this file and its class so it still sorts last.

- [ ] **Step 2: Write the scratch performance dataset**

Create `scripts/analytics-perf-seed.sql`:

```sql
-- Scratch dataset for the analytics index measurement, run against the
-- DEVELOPMENT database. Every row it creates is identifiable by the
-- 'perf-...@example.test' email prefix and is removed by
-- scripts/analytics-perf-cleanup.sql.
--
-- Distribution is skewed on purpose (docs/TESTING.md): ten busy doctors and
-- 190 quiet ones, so the plan being measured is the worst case rather than an
-- average one. The full 200-doctor / 2-million-row seed is a separate
-- deliverable; this is sized to run in a couple of minutes on a laptop.

BEGIN;

INSERT INTO users (first_name, last_name, email, password_hash, role)
SELECT 'Perf', 'Doctor ' || i, 'perf-doc-' || i || '@example.test', 'not-a-real-hash', 'DOCTOR'
FROM generate_series(1, 200) AS i;

INSERT INTO users (first_name, last_name, email, password_hash, role)
SELECT 'Perf', 'Patient ' || i, 'perf-pat-' || i || '@example.test', 'not-a-real-hash', 'PATIENT'
FROM generate_series(1, 200) AS i;

INSERT INTO doctors (user_id, specialization)
SELECT id, 'Performance fixture' FROM users WHERE email LIKE 'perf-doc-%';

INSERT INTO patients (user_id)
SELECT id FROM users WHERE email LIKE 'perf-pat-%';

-- One doctor to one patient, so each patient's appointments are exactly one
-- doctor's appointments. Both exclusion constraints are then satisfied simply
-- by giving each doctor a non-overlapping series of start times.
CREATE TEMP TABLE perf_pairs ON COMMIT DROP AS
SELECT d.rn AS k, d.id AS doctor_id, pt.id AS patient_id
FROM (SELECT dd.id, row_number() OVER (ORDER BY u.email) AS rn
      FROM doctors dd JOIN users u ON u.id = dd.user_id
      WHERE u.email LIKE 'perf-doc-%') d
JOIN (SELECT pp.id, row_number() OVER (ORDER BY u.email) AS rn
      FROM patients pp JOIN users u ON u.id = pp.user_id
      WHERE u.email LIKE 'perf-pat-%') pt ON pt.rn = d.rn;

INSERT INTO schedules (doctor_id, day_of_week, start_time, end_time, slot_duration_minutes)
SELECT pr.doctor_id, dow, TIME '09:00:00', TIME '17:00:00', 30
FROM perf_pairs pr
CROSS JOIN generate_series(0, 4) AS dow;

INSERT INTO blocks (doctor_id, start_at, end_at, reason)
SELECT pr.doctor_id,
       TIMESTAMPTZ '2024-03-01 00:00:00+00' + (m * INTERVAL '30 days'),
       TIMESTAMPTZ '2024-03-01 00:00:00+00' + (m * INTERVAL '30 days') + INTERVAL '1 day',
       'perf fixture'
FROM perf_pairs pr
CROSS JOIN generate_series(0, 11) AS m;

-- 31-minute spacing with 30-minute appointments: adjacent rows never overlap,
-- so neither exclusion constraint fires. n % 7 = 0 gives roughly 14% cancelled,
-- matching the distribution described in docs/TESTING.md.
INSERT INTO appointments (doctor_id, patient_id, start_at, end_at, status)
SELECT
  pr.doctor_id,
  pr.patient_id,
  TIMESTAMPTZ '2024-01-01 08:00:00+00' + (n * INTERVAL '31 minutes'),
  TIMESTAMPTZ '2024-01-01 08:00:00+00' + (n * INTERVAL '31 minutes') + INTERVAL '30 minutes',
  CASE WHEN n % 7 = 0 THEN 'CANCELLED' ELSE 'CONFIRMED' END
FROM perf_pairs pr
CROSS JOIN LATERAL generate_series(1, CASE WHEN pr.k <= 10 THEN 8000 ELSE 500 END) AS n;

COMMIT;

ANALYZE appointments;
ANALYZE schedules;
ANALYZE blocks;

SELECT COUNT(*) AS seeded_appointments FROM appointments;
```

- [ ] **Step 3: Write the EXPLAIN runner**

Create `scripts/analytics-explain.sql`. This is the query from
`src/analytics/analytics.sql.ts` with `$1`-`$4` replaced by literals, so the two
files must be kept in step; a difference between them invalidates the evidence.

```sql
\set ON_ERROR_STOP on

-- Measure the busiest doctor, not an average one (docs/TESTING.md).
SELECT a.doctor_id::text AS busiest
FROM appointments a
GROUP BY a.doctor_id
ORDER BY COUNT(*) DESC
LIMIT 1
\gset

\echo 'Busiest doctor id:' :busiest

EXPLAIN (ANALYZE, BUFFERS)
WITH params AS (
  SELECT
    :'busiest'::uuid AS doctor_id,
    'Africa/Cairo'::text AS tz,
    (make_date(2024, 3, 1)::timestamp AT TIME ZONE 'Africa/Cairo') AS month_start,
    ((make_date(2024, 3, 1) + INTERVAL '1 month')::timestamp AT TIME ZONE 'Africa/Cairo') AS month_end
),
stats AS (
  SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE a.status = 'CANCELLED') AS cancelled,
    COALESCE(
      SUM(EXTRACT(EPOCH FROM (a.end_at - a.start_at)) / 60)
        FILTER (WHERE a.status = 'CONFIRMED'),
      0
    ) AS booked_minutes
  FROM appointments a, params p
  WHERE a.doctor_id = p.doctor_id
    AND a.start_at >= p.month_start
    AND a.start_at <  p.month_end
),
hourly AS (
  SELECT
    EXTRACT(HOUR FROM (a.start_at AT TIME ZONE p.tz))::int AS hour,
    COUNT(*) AS bookings
  FROM appointments a, params p
  WHERE a.doctor_id = p.doctor_id
    AND a.start_at >= p.month_start
    AND a.start_at <  p.month_end
    AND a.status = 'CONFIRMED'
  GROUP BY 1
),
peak AS (
  SELECT array_agg(h.hour ORDER BY h.hour) AS peak_hours
  FROM hourly h
  WHERE h.bookings = (SELECT MAX(h2.bookings) FROM hourly h2)
),
days AS (
  SELECT (p.month_start AT TIME ZONE p.tz)::date + offset_days AS day
  FROM params p,
       generate_series(
         0,
         ((p.month_end AT TIME ZONE p.tz)::date - (p.month_start AT TIME ZONE p.tz)::date) - 1
       ) AS offset_days
),
windows AS (
  SELECT tstzrange(
           (d.day + s.start_time) AT TIME ZONE p.tz,
           (d.day + s.end_time)   AT TIME ZONE p.tz,
           '[)'
         ) AS win
  FROM days d
  CROSS JOIN params p
  JOIN schedules s
    ON s.doctor_id = p.doctor_id
   AND s.day_of_week = EXTRACT(DOW FROM d.day)::int
),
blocked AS (
  SELECT COALESCE(
           range_agg(tstzrange(b.start_at, b.end_at, '[)')),
           '{}'::tstzmultirange
         ) AS ranges
  FROM blocks b, params p
  WHERE b.doctor_id = p.doctor_id
    AND b.start_at < p.month_end
    AND b.end_at   > p.month_start
),
capacity AS (
  SELECT COALESCE(
           SUM(EXTRACT(EPOCH FROM (upper(free.part) - lower(free.part))) / 60),
           0
         ) AS available_minutes
  FROM windows w
  CROSS JOIN blocked bl
  CROSS JOIN LATERAL unnest(tstzmultirange(w.win) - bl.ranges) AS free(part)
)
SELECT
  s.total::int AS total_appointments,
  COALESCE(ROUND(100.0 * s.cancelled / NULLIF(s.total, 0), 2), 0) AS cancellation_rate,
  COALESCE(pk.peak_hours, '{}'::int[]) AS peak_hours,
  COALESCE(ROUND(100.0 * s.booked_minutes / NULLIF(c.available_minutes, 0), 2), 0) AS utilization_rate
FROM stats s, peak pk, capacity c;
```

- [ ] **Step 4: Write the cleanup script**

Create `scripts/analytics-perf-cleanup.sql`:

```sql
-- Removes everything scripts/analytics-perf-seed.sql created, in foreign-key
-- order. Matching on the email prefix means real development data is untouched.

DELETE FROM appointments a
USING doctors d, users u
WHERE a.doctor_id = d.id AND d.user_id = u.id AND u.email LIKE 'perf-%@example.test';

DELETE FROM blocks b
USING doctors d, users u
WHERE b.doctor_id = d.id AND d.user_id = u.id AND u.email LIKE 'perf-%@example.test';

DELETE FROM schedules s
USING doctors d, users u
WHERE s.doctor_id = d.id AND d.user_id = u.id AND u.email LIKE 'perf-%@example.test';

DELETE FROM doctors d
USING users u
WHERE d.user_id = u.id AND u.email LIKE 'perf-%@example.test';

DELETE FROM patients p
USING users u
WHERE p.user_id = u.id AND u.email LIKE 'perf-%@example.test';

DELETE FROM users WHERE email LIKE 'perf-%@example.test';

ANALYZE appointments;
```

- [ ] **Step 5: Seed the scratch dataset (index not yet created)**

Do not run the migration yet — the "before" plan needs the index to be absent.

```bash
docker compose up -d postgres
Get-Content scripts/analytics-perf-seed.sql | docker compose exec -T postgres psql -U clinic -d clinic
```

Expected: the final line reports `seeded_appointments` of at least 175000
(10 busy doctors x 8000 + 190 quiet doctors x 500 = 175,000 new rows, plus any
development data already present). Expect this to take one to three minutes:
each insert also maintains two GiST exclusion indexes.

- [ ] **Step 6: Capture the plan BEFORE the index exists**

```bash
Get-Content scripts/analytics-explain.sql | docker compose exec -T postgres psql -U clinic -d clinic > before.txt
```

Expected: the plan contains `Seq Scan on appointments` twice — once for `stats`,
once for `hourly` — with `rows removed by filter` in the hundreds of thousands.

- [ ] **Step 7: Run the migration**

```bash
npm run migration:run
docker compose exec postgres psql -U clinic -d clinic -c "ANALYZE appointments;"
```

Expected: output contains
`Migration AddAppointmentsDoctorStartAtIndex1757462400000 has been executed successfully.`

- [ ] **Step 8: Verify the index exists and is not partial**

```bash
docker compose exec postgres psql -U clinic -d clinic -c "\d appointments"
```

Expected: the index list contains
`appointments_doctor_start_at_idx btree (doctor_id, start_at)` with no
`WHERE` clause after it. The `WHERE (status = 'CONFIRMED')` on the GiST
exclusion index is exactly why this second, unfiltered index is needed.

- [ ] **Step 9: Capture the plan AFTER the index exists**

```bash
Get-Content scripts/analytics-explain.sql | docker compose exec -T postgres psql -U clinic -d clinic > after.txt
```

Expected: both appointment scans become
`Index Scan using appointments_doctor_start_at_idx on appointments`, with
`Execution Time` at least an order of magnitude lower than in `before.txt`.

If either scan is still a `Seq Scan`, it is because `params` is referenced more
than once and PostgreSQL therefore materialises it, hiding the boundary values
from the planner. Change the `params` CTE header in
`src/analytics/analytics.sql.ts` and `scripts/analytics-explain.sql` to
`WITH params AS NOT MATERIALIZED (` so the boundaries fold into the predicate as
constants, re-run Steps 6 and 9, and note the change in the evidence file. The
CTE reads no tables, so recomputing it is free.

- [ ] **Step 10: Record the evidence**

Create `docs/EVIDENCE/analytics-index.md` with this structure, pasting the real
output of Steps 6 and 9 into the two code blocks and filling the three
measured numbers into the summary line:

````markdown
# Index evidence: `appointments_doctor_start_at_idx`

**Query:** the doctor monthly analytics query
(`src/analytics/analytics.sql.ts`), run for the busiest doctor and one month.
Reproduce with `scripts/analytics-explain.sql`.

**Dataset:** `scripts/analytics-perf-seed.sql` — 200 doctors, skewed so ten of
them hold 8,000 appointments each and the rest hold 500, roughly 14% cancelled.

**Index:** `CREATE INDEX appointments_doctor_start_at_idx ON appointments (doctor_id, start_at)`

**Why it is separate from the exclusion index:** `appointments_no_overlap` is
`WHERE status = 'CONFIRMED'`, and this query has to count cancelled rows too.

**Result:** execution time fell from <before> ms to <after> ms; both appointment
scans changed from `Seq Scan` to `Index Scan`.

## Before

```text
<paste before.txt here>
```

## After

```text
<paste after.txt here>
```
````

- [ ] **Step 11: Verify the migration reverts and re-runs**

```bash
npm run migration:revert
docker compose exec postgres psql -U clinic -d clinic -c "SELECT COUNT(*)::int FROM pg_indexes WHERE indexname = 'appointments_doctor_start_at_idx';"
npm run migration:run
docker compose exec postgres psql -U clinic -d clinic -c "SELECT COUNT(*)::int FROM pg_indexes WHERE indexname = 'appointments_doctor_start_at_idx';"
```

Expected: `0` after the revert, `1` after the re-run. A migration that cannot be
reverted is not finished.

- [ ] **Step 12: Remove the scratch dataset**

```bash
Get-Content scripts/analytics-perf-cleanup.sql | docker compose exec -T postgres psql -U clinic -d clinic
docker compose exec postgres psql -U clinic -d clinic -c "SELECT COUNT(*)::int FROM users WHERE email LIKE 'perf-%@example.test';"
Remove-Item before.txt, after.txt
```

Expected: the final count is `0`. The plans are preserved in
`docs/EVIDENCE/analytics-index.md`; the rows are not worth keeping.

- [ ] **Step 13: Commit**

```bash
git add src/database/migrations scripts docs/EVIDENCE/analytics-index.md
git commit -m "feat(analytics): add (doctor_id, start_at) index with EXPLAIN ANALYZE evidence"
```

---

## Task 4: Service, DTO, controller and authorization

**Files:**
- Create: `src/analytics/dto/get-doctor-analytics-query.dto.ts`
- Create: `src/analytics/analytics.service.ts`
- Create: `src/analytics/analytics.controller.ts`
- Modify: `src/analytics/analytics.repository.ts` (add `doctorExists`)
- Modify: `src/analytics/analytics.module.ts`
- Modify: `docs/PLANS/00-interfaces.md`
- Test: `src/analytics/analytics.service.spec.ts`
- Test: `test/analytics.e2e-spec.ts`

**Interfaces:**
- Consumes: `AnalyticsRepository` and `DoctorMonthlyAnalytics` (Task 2);
  `DoctorOwnershipGuard` from `src/auth/guards/doctor-ownership.guard.ts`
  (Plan 2); `JwtPayload` from `src/auth/jwt-payload.interface.ts` (Plan 2);
  `AppException` and `ErrorCode` (Plan 1); the fixture helpers (Task 1).
- Produces:
  ```ts
  class AnalyticsRepository {
    doctorExists(doctorId: string): Promise<boolean>;
  }

  class AnalyticsService {
    getDoctorMonthlyAnalytics(
      doctorId: string,
      year: number,
      month: number,
    ): Promise<DoctorMonthlyAnalytics>;
  }

  class GetDoctorAnalyticsQueryDto {
    year: number;   // 2000-2100
    month: number;  // 1-12
  }
  ```
  `GET /doctors/:doctorId/analytics?year=&month=` returning
  `DoctorMonthlyAnalytics` as JSON.

- [ ] **Step 1: Write the failing service unit test**

Create `src/analytics/analytics.service.spec.ts`:

```ts
import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-code.enum';
import { AnalyticsRepository } from './analytics.repository';
import { AnalyticsService } from './analytics.service';

describe('AnalyticsService', () => {
  const repository = {
    doctorExists: jest.fn(),
    getDoctorMonthlyAnalytics: jest.fn(),
  };
  const service = new AnalyticsService(repository as unknown as AnalyticsRepository);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns the repository result unchanged', async () => {
    const analytics = {
      totalAppointments: 4,
      cancellationRate: 50,
      peakHours: [10],
      utilizationRate: 12.5,
    };
    repository.doctorExists.mockResolvedValue(true);
    repository.getDoctorMonthlyAnalytics.mockResolvedValue(analytics);

    const result = await service.getDoctorMonthlyAnalytics('doctor-1', 2026, 2);

    expect(result).toBe(analytics);
    expect(repository.getDoctorMonthlyAnalytics).toHaveBeenCalledWith('doctor-1', 2026, 2);
  });

  it('throws a 404 with code NOT_FOUND for an unknown doctor', async () => {
    repository.doctorExists.mockResolvedValue(false);

    await expect(service.getDoctorMonthlyAnalytics('nobody', 2026, 2)).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });
    await expect(
      service.getDoctorMonthlyAnalytics('nobody', 2026, 2),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('does not run the analytics query for an unknown doctor', async () => {
    repository.doctorExists.mockResolvedValue(false);

    await expect(service.getDoctorMonthlyAnalytics('nobody', 2026, 2)).rejects.toThrow();

    expect(repository.getDoctorMonthlyAnalytics).not.toHaveBeenCalled();
  });

  it('raises the 404 with HTTP status 404', async () => {
    repository.doctorExists.mockResolvedValue(false);

    try {
      await service.getDoctorMonthlyAnalytics('nobody', 2026, 2);
      throw new Error('expected getDoctorMonthlyAnalytics to throw');
    } catch (error) {
      expect((error as AppException).getStatus()).toBe(HttpStatus.NOT_FOUND);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/analytics/analytics.service.spec.ts`
Expected: FAIL — `Cannot find module './analytics.service'`.

- [ ] **Step 3: Add `doctorExists` to the repository**

Append to `src/analytics/analytics.repository.ts`, inside the class:

```ts
  /**
   * Existence check for the 404 in AnalyticsService.
   *
   * It lives here rather than on DoctorsService so the analytics feature owns
   * every query it makes, and it is a separate statement rather than a join
   * inside the analytics query because "this doctor does not exist" and "this
   * doctor has no data" are different answers with different status codes.
   */
  async doctorExists(doctorId: string): Promise<boolean> {
    const rows: unknown[] = await this.dataSource.query(
      'SELECT 1 FROM doctors WHERE id = $1',
      [doctorId],
    );

    return rows.length > 0;
  }
```

- [ ] **Step 4: Write the service**

Create `src/analytics/analytics.service.ts`:

```ts
import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-code.enum';
import { AnalyticsRepository } from './analytics.repository';
import { DoctorMonthlyAnalytics } from './doctor-monthly-analytics.interface';

@Injectable()
export class AnalyticsService {
  constructor(private readonly repository: AnalyticsRepository) {}

  /**
   * There is deliberately no computation here. Every metric is produced by
   * PostgreSQL; this method exists to turn a missing doctor into a 404 and to
   * keep the controller out of the repository.
   */
  async getDoctorMonthlyAnalytics(
    doctorId: string,
    year: number,
    month: number,
  ): Promise<DoctorMonthlyAnalytics> {
    const exists = await this.repository.doctorExists(doctorId);

    if (!exists) {
      throw new AppException(ErrorCode.NotFound, 'Doctor not found', HttpStatus.NOT_FOUND);
    }

    return this.repository.getDoctorMonthlyAnalytics(doctorId, year, month);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/analytics/analytics.service.spec.ts`
Expected: PASS — 4 tests.

- [ ] **Step 6: Write the query DTO**

Create `src/analytics/dto/get-doctor-analytics-query.dto.ts`:

```ts
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class GetDoctorAnalyticsQueryDto {
  /**
   * Query-string values arrive as strings and the global ValidationPipe is
   * configured with `transform: true` but not `enableImplicitConversion`, so
   * the @Type decorator is what makes @IsInt meaningful here.
   */
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;
}
```

- [ ] **Step 7: Write the failing HTTP test**

Create `test/analytics.e2e-spec.ts`:

```ts
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import {
  createAppointment,
  createDoctor,
  createPatient,
  createSchedule,
  resetAnalyticsData,
  userIdForDoctor,
  userIdForPatient,
} from './fixtures/analytics.fixture';

describe('GET /doctors/:doctorId/analytics', () => {
  let app: INestApplication;
  let ds: DataSource;
  let jwt: JwtService;

  let doctorId: string;
  let otherDoctorId: string;
  let adminToken: string;
  let ownerToken: string;
  let otherDoctorToken: string;
  let patientToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    ds = app.get(DataSource);
    jwt = app.get(JwtService);

    await resetAnalyticsData(ds);

    doctorId = await createDoctor(ds, 'owner');
    otherDoctorId = await createDoctor(ds, 'other');
    const patientId = await createPatient(ds, 'viewer');

    // Same fixture as the repository test's first block:
    // Sundays 10:00-12:00 Cairo, 4 Sundays in February 2026 -> 480 minutes.
    await createSchedule(ds, {
      doctorId,
      dayOfWeek: 0,
      startTime: '10:00:00',
      endTime: '12:00:00',
      slotDurationMinutes: 30,
    });
    // Sun 1 Feb 10:00 and 10:30 Cairo, CONFIRMED.
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
    // Sun 8 Feb 11:00 and 11:30 Cairo, CANCELLED.
    await createAppointment(ds, {
      doctorId,
      patientId,
      startAt: '2026-02-08T09:00:00Z',
      endAt: '2026-02-08T09:30:00Z',
      status: 'CANCELLED',
    });
    await createAppointment(ds, {
      doctorId,
      patientId,
      startAt: '2026-02-08T09:30:00Z',
      endAt: '2026-02-08T10:00:00Z',
      status: 'CANCELLED',
    });

    // Tokens are signed directly against the JwtPayload contract in
    // docs/PLANS/00-interfaces.md rather than obtained from /auth/login, so
    // this suite tests the analytics contract and not the login one.
    // JwtAuthGuard resolves doctorId/patientId from the database per request.
    const adminUserId = await createAdmin(ds, 'admin');
    adminToken = jwt.sign({ sub: adminUserId, role: 'ADMIN' });
    ownerToken = jwt.sign({ sub: await userIdForDoctor(ds, doctorId), role: 'DOCTOR' });
    otherDoctorToken = jwt.sign({
      sub: await userIdForDoctor(ds, otherDoctorId),
      role: 'DOCTOR',
    });
    patientToken = jwt.sign({ sub: await userIdForPatient(ds, patientId), role: 'PATIENT' });
  });

  afterAll(async () => {
    await app.close();
  });

  async function createAdmin(dataSource: DataSource, label: string): Promise<string> {
    const [user] = await dataSource.query(
      `INSERT INTO users (first_name, last_name, email, password_hash, role)
       VALUES ($1, 'Admin', $2, 'not-a-real-hash', 'ADMIN')
       RETURNING id`,
      [label, `${label}.admin@analytics.test`],
    );
    return user.id;
  }

  it('returns the computed metrics to an ADMIN for any doctor', async () => {
    const response = await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/analytics?year=2026&month=2`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // total       = 2 CONFIRMED + 2 CANCELLED = 4
    // cancelled   = 2 / 4 * 100              = 50
    // peak hours  = local hour 10, twice (cancelled rows are at hour 11)
    // utilization = 60 booked / 480 available * 100 = 12.5
    expect(response.body).toEqual({
      totalAppointments: 4,
      cancellationRate: 50,
      peakHours: [10],
      utilizationRate: 12.5,
    });
  });

  it('returns the metrics to the owning doctor', async () => {
    const response = await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/analytics?year=2026&month=2`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(response.body.totalAppointments).toBe(4);
  });

  it('rejects a different doctor with 403', async () => {
    const response = await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/analytics?year=2026&month=2`)
      .set('Authorization', `Bearer ${otherDoctorToken}`)
      .expect(403);

    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('rejects a patient with 403', async () => {
    await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/analytics?year=2026&month=2`)
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(403);
  });

  it('rejects an unauthenticated request with 401', async () => {
    await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/analytics?year=2026&month=2`)
      .expect(401);
  });

  it('rejects month 13 with 400', async () => {
    const response = await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/analytics?year=2026&month=13`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);

    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a missing month with 400', async () => {
    await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/analytics?year=2026`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('rejects an unexpected query parameter with 400', async () => {
    await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/analytics?year=2026&month=2&doctorId=someone-else`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('returns 404 for a doctor that does not exist', async () => {
    const response = await request(app.getHttpServer())
      .get('/doctors/00000000-0000-4000-8000-000000000000/analytics?year=2026&month=2')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);

    expect(response.body.code).toBe('NOT_FOUND');
  });
});
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `npx jest --config test/jest-e2e.json test/analytics.e2e-spec.ts`
Expected: FAIL — every request returns 404 `Cannot GET /doctors/.../analytics`,
because the controller does not exist yet.

- [ ] **Step 9: Write the controller**

Create `src/analytics/analytics.controller.ts`:

```ts
import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { DoctorOwnershipGuard } from '../auth/guards/doctor-ownership.guard';
import { AnalyticsService } from './analytics.service';
import { DoctorMonthlyAnalytics } from './doctor-monthly-analytics.interface';
import { GetDoctorAnalyticsQueryDto } from './dto/get-doctor-analytics-query.dto';

/**
 * Nested under the doctor so DoctorOwnershipGuard has an explicit subject to
 * check (docs/DECISIONS.md #11).
 *
 * JwtAuthGuard is global (Plan 2), so only the ownership guard is added here.
 * RolesGuard is not needed: DoctorOwnershipGuard passes for ADMIN or for the
 * addressed doctor, and a PATIENT has no doctorId, so it fails for them.
 */
@Controller('doctors/:doctorId/analytics')
@UseGuards(DoctorOwnershipGuard)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get()
  getMonthly(
    @Param('doctorId', ParseUUIDPipe) doctorId: string,
    @Query() query: GetDoctorAnalyticsQueryDto,
  ): Promise<DoctorMonthlyAnalytics> {
    return this.analyticsService.getDoctorMonthlyAnalytics(doctorId, query.year, query.month);
  }
}
```

- [ ] **Step 10: Register the controller and service in the module**

Replace `src/analytics/analytics.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsRepository } from './analytics.repository';
import { AnalyticsService } from './analytics.service';

// No TypeOrmModule.forFeature: the repository executes raw SQL through the
// injected DataSource and owns no entity.
@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, AnalyticsRepository],
  exports: [AnalyticsRepository],
})
export class AnalyticsModule {}
```

- [ ] **Step 11: Run the test to verify it passes**

Run: `npx jest --config test/jest-e2e.json test/analytics.e2e-spec.ts`
Expected: PASS — 9 tests.

- [ ] **Step 12: Record the additions in the shared contract**

`docs/PLANS/00-interfaces.md` is the single source of truth and says to update
it rather than diverge. In its `## AnalyticsRepository (Plan 8)` section, add
below the existing `getDoctorMonthlyAnalytics` signature:

```ts
/** Existence check behind the 404 in AnalyticsService. */
doctorExists(doctorId: string): Promise<boolean>
```

and add a new section immediately after it:

````md
## AnalyticsService (Plan 8)

```ts
getDoctorMonthlyAnalytics(
  doctorId: string,
  year: number,
  month: number,   // 1-12
): Promise<DoctorMonthlyAnalytics>
```

Throws `AppException(ErrorCode.NotFound, 'Doctor not found', 404)` when the
doctor does not exist. The HTTP response body is `DoctorMonthlyAnalytics`
verbatim; there is no separate response DTO.
````

- [ ] **Step 13: Commit**

```bash
git add src/analytics docs/PLANS/00-interfaces.md test/analytics.e2e-spec.ts
git commit -m "feat(analytics): add doctor monthly analytics endpoint with ownership guard"
```

---

## Task 5: Prove the computation stayed in PostgreSQL

The one requirement that erodes silently. A later change that loads
appointments and counts them in JavaScript would keep every test above green
except this one.

**Files:**
- Test: `src/analytics/analytics.architecture.spec.ts`

**Interfaces:**
- Consumes: the source files created in Tasks 2 and 4.
- Produces: nothing importable. This task's deliverable is a guard.

- [ ] **Step 1: Write the guard test**

Create `src/analytics/analytics.architecture.spec.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOCTOR_MONTHLY_ANALYTICS_SQL } from './analytics.sql';

const SOURCES = ['analytics.repository.ts', 'analytics.service.ts', 'analytics.controller.ts'];

// docs/FEATURES/Analytics.md: "The calculations MUST happen in PostgreSQL."
// Every one of these patterns is a way of loading rows and aggregating them in
// JavaScript, which is the failure mode this whole feature is written to avoid.
const FORBIDDEN = [
  /\.find\(/,
  /\.findOne\(/,
  /\.reduce\(/,
  /\.filter\(/,
  /createQueryBuilder/,
  /InjectRepository/,
];

describe('the analytics path computes in PostgreSQL, not in JavaScript', () => {
  it.each(SOURCES)('%s contains no row-level aggregation', (file) => {
    const source = readFileSync(join(__dirname, file), 'utf8');

    for (const pattern of FORBIDDEN) {
      expect(source).not.toMatch(pattern);
    }
  });

  it('does the aggregation in SQL', () => {
    // The four metrics, each traceable to an aggregate in the query.
    expect(DOCTOR_MONTHLY_ANALYTICS_SQL).toContain('COUNT(*)');
    expect(DOCTOR_MONTHLY_ANALYTICS_SQL).toContain("FILTER (WHERE a.status = 'CANCELLED')");
    expect(DOCTOR_MONTHLY_ANALYTICS_SQL).toContain('array_agg(h.hour ORDER BY h.hour)');
    expect(DOCTOR_MONTHLY_ANALYTICS_SQL).toContain('range_agg(');
  });

  it('guards both divisions with NULLIF', () => {
    expect(DOCTOR_MONTHLY_ANALYTICS_SQL).toContain('NULLIF(s.total, 0)');
    expect(DOCTOR_MONTHLY_ANALYTICS_SQL).toContain('NULLIF(c.available_minutes, 0)');
  });

  it('bounds the month in clinic-local time, using the timezone parameter', () => {
    // $4 is CLINIC_TZ. If either boundary were built without it, the month
    // would be a UTC month.
    expect(DOCTOR_MONTHLY_ANALYTICS_SQL).toContain(
      "make_date($2::int, $3::int, 1)::timestamp AT TIME ZONE $4::text",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx jest src/analytics/analytics.architecture.spec.ts`
Expected: PASS — 7 tests (the `it.each` block counts as three).

- [ ] **Step 3: Verify it actually fails when the rule is broken**

A guard test that cannot fail is decoration. Temporarily add
`const rows = [].filter(Boolean);` to the top of the
`getDoctorMonthlyAnalytics` method in `src/analytics/analytics.repository.ts`,
re-run the test, then remove the line.

Run: `npx jest src/analytics/analytics.architecture.spec.ts`
Expected: FAIL on `analytics.repository.ts contains no row-level aggregation`,
then PASS again once the line is removed.

- [ ] **Step 4: Run the whole suite**

```bash
npm test
docker compose --profile test up -d postgres-test
npm run test:e2e
```

Expected: both green, including 4 service unit tests, 7 architecture assertions,
9 fixture assertions, 13 repository assertions and 9 HTTP assertions.

- [ ] **Step 5: Commit**

```bash
git add src/analytics/analytics.architecture.spec.ts
git commit -m "test(analytics): guard against aggregating appointments in JavaScript"
```

---

## Definition of Done

- [ ] `npm test` passes, including `analytics.service.spec.ts` and
      `analytics.architecture.spec.ts`.
- [ ] `npm run test:e2e` passes, including `analytics-fixture.e2e-spec.ts`,
      `analytics-repository.e2e-spec.ts` and `analytics.e2e-spec.ts`.
- [ ] `npm run migration:revert` followed by `npm run migration:run` succeeds and
      `appointments_doctor_start_at_idx` is present afterwards.
- [ ] `docs/EVIDENCE/analytics-index.md` contains two real `EXPLAIN ANALYZE`
      outputs, and the "after" plan shows
      `Index Scan using appointments_doctor_start_at_idx`.
- [ ] `grep -c "dataSource.query" src/analytics/analytics.repository.ts` returns
      `2` — the analytics query and the existence check, nothing else.
- [ ] `grep -rn "\.find(" src/analytics/` returns nothing.
- [ ] `docker compose exec postgres psql -U clinic -d clinic -c "SHOW server_version"`
      reports 16.x, so `range_agg` and multirange types are available.
- [ ] `curl -H "Authorization: Bearer <admin token>" "localhost:3000/doctors/<id>/analytics?year=2026&month=2"`
      returns all four metrics.

The two worth actually re-running by hand are the month-boundary test and the
block-subtraction test. Both fail in ways that still look like plausible
numbers, which is precisely why they exist.

---

## Self-Review

Run before handing the plan on; issues found were fixed inline.

**1. Spec coverage.** Every requirement maps to a task: raw-SQL repository
(Task 2), service (Task 4), controller and DTOs (Task 4), tests (Tasks 1, 2, 4,
5), the `(doctor_id, start_at)` migration with `EXPLAIN ANALYZE` before and
after (Task 3), computation in PostgreSQL with a verification step (Task 5 plus
the round-trip and scalar-shape assertions in Task 2), one round trip (Task 2
Step 2), clinic-local month boundaries (Task 2, "month boundaries in
clinic-local time"), `EXTRACT(DOW)` = 0 for Sunday (stated in Global
Constraints, the walkthrough, the SQL comment, and asserted indirectly by the
block-subtraction test), merged blocks (Task 2, "blocks are subtracted only
where they overlap a working window"), `range_agg` needing PostgreSQL 14+ (Global Constraints and
the SQL header comment), `NULLIF` guards with zero-appointment and no-schedule
tests (Task 2, "guarded divisions"), cancelled counted in totals but not booked
minutes in a single fixture (Task 2, first block), tied peak hours (Task 2,
"peak hours with a tie"), ADMIN-or-owning-doctor authorization (Task 4), a
reversible migration verified by revert-then-re-run (Task 3 Step 11), a commit
step ending every task, and the prose walkthrough above.

**2. Placeholder scan.** No "TBD", "similar to Task N", "handle edge cases" or
"write tests for the above". The full SQL appears twice on purpose — once as the
TypeScript constant in Task 2 Step 4 and once with literals in
`scripts/analytics-explain.sql` in Task 3 Step 3, because psql cannot bind `$1`
parameters; Task 3 Step 3 states that the two must be kept in step. The two
placeholder-looking items are the pasted `EXPLAIN ANALYZE` output and the three
measured numbers in `docs/EVIDENCE/analytics-index.md`, which cannot be known
before the measurement is taken; the surrounding structure and the commands that
produce them are given in full.

**3. Type consistency.** `DoctorMonthlyAnalytics` fields
(`totalAppointments`, `cancellationRate`, `peakHours`, `utilizationRate`) match
`docs/PLANS/00-interfaces.md` exactly and are used unchanged in the repository
mapping, the service, the controller return type, the repository tests, the HTTP
test and the architecture test. The SQL column aliases
(`total_appointments`, `cancellation_rate`, `peak_hours`, `utilization_rate`)
match `AnalyticsRow` in the repository. `AnalyticsRepository.getDoctorMonthlyAnalytics`
and `AnalyticsService.getDoctorMonthlyAnalytics` take
`(doctorId: string, year: number, month: number)` everywhere. The fixture
helpers named in Task 1's Produces block are the ones imported in Tasks 2 and 4.
The migration class name and its `name` property both read
`AddAppointmentsDoctorStartAtIndex1757462400000`, and the index name
`appointments_doctor_start_at_idx` is identical in the migration, the
verification steps, the evidence file and the Definition of Done.

**Divergences from the docs, resolved deliberately:**

- `docs/FEATURES/Analytics.md` shows the final select guarding both divisions
  with `NULLIF` only. `NULLIF` prevents the division-by-zero error but yields
  `NULL`, not the zero its own prose and `docs/DECISIONS.md` #9 promise. This
  plan wraps both in `COALESCE(..., 0)`.
- The same file describes block subtraction in one place as "range intersection
  (`*` on `tstzrange`)". PostgreSQL has no `range * multirange` operator, and
  intersecting per block is the double-counting bug the same file warns about
  two sections later. This plan uses multirange difference,
  `tstzmultirange(win) - merged_blocks`, which is one operator, cannot subtract
  a minute twice, and cannot drive a window negative. `blocks_no_overlap`
  (Plan 3) already makes overlapping blocks unstorable, so this is belt and
  braces rather than the only defence — but it is free, and it does not depend
  on that constraint remaining in place.
- Neither `docs/API.md` nor `docs/FEATURES/Analytics.md` specifies the analytics
  response body. Task 4 fixes it as `DoctorMonthlyAnalytics` serialised
  verbatim, with no separate response DTO, and records that in
  `docs/PLANS/00-interfaces.md`.
- `docs/PLANS/00-interfaces.md` gives no `AnalyticsService` signature and no
  existence check. Task 4 adds both and writes them back into that file rather
  than diverging from it.

---

## Next

Nothing depends on this plan. It consumes the `appointments`, `schedules` and
`blocks` tables and the ownership guard, and adds one index and one read-only
endpoint. The `EXPLAIN ANALYZE` output in `docs/EVIDENCE/analytics-index.md` is
the input to the README's index-justification section, and should be re-measured
against the full 200-doctor / 2-million-row seed when that seed exists.
