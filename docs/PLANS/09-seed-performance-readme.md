# Seed, Performance Evidence and README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deterministic seed script that loads roughly 200 doctors and ~2
million appointments in minutes rather than hours, `EXPLAIN ANALYZE` evidence
for every index in `docs/DATABASE.md` measured against the busiest doctor, and
the README the task actually grades — setup, concurrency, indexes, waiting-list
assumptions, limitations and an honest AI-usage section.

**Architecture:** The seed generates rows in memory and streams them into
PostgreSQL with `COPY ... FROM STDIN`, with every constraint left switched on so
the load is also a correctness test of the generator. Appointments are drawn
from each doctor's own slot grid — produced by the same `generateSlots()`
function the availability endpoint uses — so no generated row can overlap
another for the same doctor, and a per-patient occupancy set guarantees the same
for patients. Performance evidence is captured by dropping each index inside a
transaction that is then rolled back, which is genuinely "without the index"
while being impossible to leave half-applied.

**Tech Stack:** Node 22, TypeScript 5.7, `pg` + `pg-copy-streams`, Luxon,
PostgreSQL 16, Docker Compose, psql, Jest 30.

## Global Constraints

- No `synchronize: true`, in any environment. The seed runs *after* `migrate`
  and never creates or alters schema. (`docs/STACK.md`)
- The seed must not violate `appointments_no_overlap`,
  `appointments_patient_no_overlap` or `blocks_no_overlap`. Those constraints
  stay enabled throughout the load; a generator bug must fail loudly with
  SQLSTATE `23P01`, not produce quietly wrong data. (`docs/DATABASE.md`)
- One block per doctor per day, so blocked periods cannot overlap.
  (`docs/DECISIONS.md` #18)
- Database identifiers are `snake_case`; TypeScript is `camelCase`. Column and
  table names come from `docs/PLANS/00-interfaces.md` and nothing else.
- `schedules.day_of_week` uses **0 = Sunday .. 6 = Saturday**, matching
  `EXTRACT(DOW)`. (`docs/DATABASE.md`)
- Ranges are half-open `'[)'`. Back-to-back slots do not overlap.
  (`docs/DATABASE.md`)
- The seed is deterministic. One fixed integer seed produces one fixed dataset,
  so `EXPLAIN ANALYZE` numbers are comparable between runs and machines.
- All configuration comes from environment variables. The seed reads
  `DATABASE_URL` and `CLINIC_TZ` and hardcodes neither. (`docs/DEVELOPMENT.md`)
- Time in the seed is derived from `CLINIC_TZ` via Luxon, never from the host's
  local zone. (`docs/STACK.md`)
- Seeded users all share **one** bcrypt hash of one password, produced with the
  same library and cost factor Plan 2 uses (`bcrypt`). Hashing 120,000 distinct
  passwords would take hours and prove nothing.
- Commit messages follow `docs/DEVELOPMENT.md`, e.g.
  `feat(seed): generate skewed appointment data without overlaps`.
- PostgreSQL major version **16**, Redis **7**.
  (`docs/INFRASTRUCTURE/Deployment.md`)

### Marker convention used by this plan

Some README cells can only be filled by running Part B. Those cells contain the
literal token `MEASURED`. It is not a plan placeholder — the step that writes it
names the exact command whose output replaces it, and the Definition of Done
greps the committed README to prove none survive.

---

## What earlier plans provide

- **Plan 1:** `docker-compose.yml` (postgres, postgres-test, redis, migrate,
  api), the multi-stage `Dockerfile` with a `migrate` target that has full
  TypeScript sources and dev dependencies, `.env.example`, `src/config`,
  `src/database/data-source.ts`, `Clock`, `AllExceptionsFilter`, `GET /health`.
- **Plans 2–4:** `User`, `Doctor`, `Patient`, `Schedule`, `Block` entities and
  tables; `generateSlots()` in `src/availability/slot-generator.ts`.
- **Plan 5:** `Appointment`, both exclusion constraints, nginx plus two `api`
  replicas published on `:8080`, and `npm run test:concurrency`.
- **Plan 6:** `Notification`, the `worker` service, the BullMQ queues and the
  reconciliation sweeper.
- **Plan 7:** `WaitingListEntry` and `waiting_list_one_active`.
- **Plan 8:** the analytics SQL.

---

## File Structure

**Created by this plan:**

```text
src/database/seeds/
  seed.ts                              CLI entry point, phase orchestration, VACUUM ANALYZE
  seed.config.ts                       sizes, tiers, distribution knobs; full and small scales
  random.ts                            deterministic mulberry32 PRNG
  copy-writer.ts                       COPY text encoding + streaming helper
  occupancy.ts                         per-patient 15-minute bucket occupancy
  phase-timer.ts                       per-phase rows/seconds/rows-per-second report
  generators/
    people.generator.ts                admin, doctor and patient users + profiles
    schedules.generator.ts             weekly schedule rows and blocked periods per tier
    appointments.generator.ts          skewed appointment + notification row generation
    waiting-list.generator.ts          waiting-list entries on contested future slots

scripts/perf/
  explain-evidence.sql                 driver, \i-includes the rest in order
  00-context.sql                       picks busiest doctor/patient/month into psql vars
  01-availability.sql                  Q1, the GiST exclusion index
  02-patient-appointments.sql          Q2, (patient_id, start_at)
  03-analytics-month.sql               Q3, (doctor_id, start_at)
  04-blocks.sql                        Q4, (doctor_id, start_at, end_at)
  05-waiting-list.sql                  Q5 and Q6
  06-notifications.sql                 Q7 and Q8

docs/PERFORMANCE.md                    the eight plans, annotated
docs/performance/                      raw captured psql output
```

**Modified:** `package.json` (three scripts, three dev dependencies),
`docker-compose.yml` (the `seed` service and a read-only `./scripts/perf` mount
on `postgres`), `README.md` (replaced wholesale).

Responsibilities are deliberately narrow. `random.ts`, `copy-writer.ts` and
`occupancy.ts` are pure and unit-tested; the `generators/` files know about
domain shapes but do no I/O; `seed.ts` is the only file that opens a connection.

---

## Task 1: Deterministic randomness and the COPY writer

Everything else in Part A depends on these two primitives, and both are pure, so
they get real unit tests before anything touches a database.

**Files:**
- Create: `src/database/seeds/random.ts`
- Create: `src/database/seeds/copy-writer.ts`
- Test: `src/database/seeds/random.spec.ts`
- Test: `src/database/seeds/copy-writer.spec.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing from earlier plans.
- Produces: `class Rng` with `next(): number`, `int(min, max): number`,
  `pick<T>(items: readonly T[]): T`, `chance(probability: number): boolean`;
  `encodeCopyValue(value): string`; `encodeCopyRow(values): string`;
  `copyRows(client: PoolClient, table: string, columns: string[], rows:
  Iterable<string>): Promise<void>`.

- [ ] **Step 1: Install the dependencies**

```bash
npm install --save-dev pg-copy-streams @types/pg-copy-streams @types/pg
```

`pg` itself is already a runtime dependency from Plan 1. `pg-copy-streams` is a
dev dependency because the seed is a development tool and runs from the
`migrate` build stage, which installs dev dependencies.

- [ ] **Step 2: Write the failing PRNG test**

Create `src/database/seeds/random.spec.ts`:

```ts
import { Rng } from './random';

describe('Rng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = new Rng(20260902);
    const b = new Rng(20260902);
    const first = [a.next(), a.next(), a.next(), a.next(), a.next()];
    const second = [b.next(), b.next(), b.next(), b.next(), b.next()];

    expect(first).toEqual(second);
  });

  it('produces a different sequence for a different seed', () => {
    const a = new Rng(1);
    const b = new Rng(2);

    expect(a.next()).not.toBe(b.next());
  });

  it('stays inside [0, 1)', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 1000; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('returns integers inside the inclusive range', () => {
    const rng = new Rng(11);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(rng.int(3, 5));
    }

    expect([...seen].sort()).toEqual([3, 4, 5]);
  });

  it('honours chance() at the extremes', () => {
    const rng = new Rng(13);

    expect(rng.chance(1)).toBe(true);
    expect(rng.chance(0)).toBe(false);
  });
});
```

Determinism is the point of the first test. Without it, two `EXPLAIN ANALYZE`
runs would be measuring two different datasets and the README numbers would not
be comparable to anything.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest src/database/seeds/random.spec.ts`
Expected: FAIL — `Cannot find module './random'`.

- [ ] **Step 4: Implement the PRNG**

Create `src/database/seeds/random.ts`:

```ts
/**
 * Deterministic pseudo-random generator (mulberry32).
 *
 * `Math.random()` cannot be seeded, so the dataset would differ on every run and
 * the EXPLAIN ANALYZE numbers recorded in the README would not be reproducible.
 * Statistical quality is irrelevant here; repeatability is the requirement.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }

  /** True with the given probability. */
  chance(probability: number): boolean {
    return this.next() < probability;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/database/seeds/random.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Write the failing COPY encoder test**

Create `src/database/seeds/copy-writer.spec.ts`:

```ts
import { encodeCopyRow, encodeCopyValue } from './copy-writer';

describe('encodeCopyValue', () => {
  it('encodes null as the COPY null marker', () => {
    expect(encodeCopyValue(null)).toBe('\\N');
  });

  it('encodes a Date as an ISO-8601 UTC instant', () => {
    expect(encodeCopyValue(new Date('2026-09-06T07:00:00.000Z'))).toBe(
      '2026-09-06T07:00:00.000Z',
    );
  });

  it('encodes booleans and numbers as text', () => {
    expect(encodeCopyValue(true)).toBe('true');
    expect(encodeCopyValue(30)).toBe('30');
  });

  it('escapes backslash, tab, newline and carriage return', () => {
    expect(encodeCopyValue('a\\b\tc\nd\re')).toBe('a\\\\b\\tc\\nd\\re');
  });

  it('leaves ordinary text alone', () => {
    expect(encodeCopyValue("O'Brien")).toBe("O'Brien");
  });
});

describe('encodeCopyRow', () => {
  it('joins values with tabs and terminates the row with a newline', () => {
    expect(encodeCopyRow(['a', 1, null])).toBe('a\t1\t\\N\n');
  });
});
```

The escaping tests are not decoration. An unescaped tab in a `reason` string
would silently shift every following column by one, and COPY would either fail
with a confusing type error two million rows in, or succeed with corrupt data.

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx jest src/database/seeds/copy-writer.spec.ts`
Expected: FAIL — `Cannot find module './copy-writer'`.

- [ ] **Step 8: Implement the COPY writer**

Create `src/database/seeds/copy-writer.ts`:

```ts
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { PoolClient } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';

export type CopyValue = string | number | boolean | Date | null;

const NULL_MARKER = '\\N';
const BLOCK_BYTES = 64 * 1024;

/** Escapes one value for PostgreSQL's COPY text format. */
export function encodeCopyValue(value: CopyValue): string {
  if (value === null) {
    return NULL_MARKER;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== 'string') {
    return String(value);
  }

  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

export function encodeCopyRow(values: CopyValue[]): string {
  return `${values.map(encodeCopyValue).join('\t')}\n`;
}

/** Groups pre-encoded rows into ~64 KB blocks so the stream does fewer writes. */
function* blocks(rows: Iterable<string>): Generator<string> {
  let buffer = '';

  for (const row of rows) {
    buffer += row;
    if (buffer.length >= BLOCK_BYTES) {
      yield buffer;
      buffer = '';
    }
  }

  if (buffer.length > 0) {
    yield buffer;
  }
}

/**
 * Streams pre-encoded rows into a table with COPY ... FROM STDIN.
 *
 * Chosen over multi-row INSERT for two reasons. PostgreSQL accepts at most
 * 65535 bind parameters per statement, which caps an appointments INSERT
 * (10 columns) at about 6500 rows and forces thousands of round trips; and
 * every one of those statements pays parse and plan cost that COPY pays once.
 */
export async function copyRows(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: Iterable<string>,
): Promise<void> {
  const stream = client.query(copyFrom(`COPY ${table} (${columns.join(', ')}) FROM STDIN`));
  await pipeline(Readable.from(blocks(rows)), stream);
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx jest src/database/seeds/copy-writer.spec.ts`
Expected: PASS — 6 tests.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json src/database/seeds
git commit -m "chore(seed): add deterministic RNG and COPY writer for bulk seeding"
```

---

## Task 2: Seed configuration and the skew arithmetic

The distribution is decided here, in one file, with the capacity arithmetic
visible. `docs/TESTING.md` requires the distribution to be skewed rather than
uniform, and `docs/DECISIONS.md` #17 explains why: a uniform 10,000 rows per
doctor is the easiest possible case for every index, and the busiest doctor's
plan is the number worth reporting.

**Files:**
- Create: `src/database/seeds/seed.config.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface DoctorTier`, `interface SeedConfig`, `FULL_SCALE`,
  `SMALL_SCALE`, `resolveScale(argv: string[]): SeedConfig`,
  `SEED_PASSWORD`. Consumed by every later task in Part A.

- [ ] **Step 1: Work out what the skew can actually be**

Before writing the file, note the constraint nobody expects: a doctor cannot
hold 80,000 appointments in two years, because there are not that many working
hours. A doctor on a six-day week with twelve working hours a day and
15-minute slots has about 30,000 slots across 24 months. With 200 doctors and
2,000,000 appointments the mean is 10,000, so the achievable ratio between the
busiest doctor and the mean is roughly 2.5:1, and between busiest and quietest
roughly 6:1.

That is a real skew, and it is the honest one. The tiers below are sized so
every doctor's appointment count is comfortably below their own grid capacity;
the generator asserts this rather than trusting it.

| Tier | Doctors | Working days | Windows (clinic-local) | Slot | Grid slots | Appointments each | Fill | Total |
|---|---|---|---|---|---|---|---|---|
| popular | 10 | Sun–Fri | 08:00–14:00, 15:00–21:00 | 15 min | ~30,000 | 24,000 | 80% | 240,000 |
| busy | 40 | Sun–Thu | 09:00–13:00, 14:00–18:00 | 15 min | ~16,700 | 13,500 | 81% | 540,000 |
| regular | 90 | Sun–Thu | 09:00–13:00, 14:00–18:00 | 15 min | ~16,700 | 11,000 | 66% | 990,000 |
| quiet | 60 | Sun–Thu | 10:00–13:00, 14:00–17:00 | 30 min | ~6,250 | 3,833 | 61% | 229,980 |
| **total** | **200** | | | | | | | **1,999,980** |

On top of that base, about 15% of rows are CANCELLED, and one in ten cancelled
slots is rebooked by a different patient — adding roughly 30,000 extra rows and
bringing the table to a little over 2.0 million. The exact figure depends on the
PRNG and is recorded by the verification step in Task 6, not guessed here.

The two windows per working day exist for a reason beyond realism: they are
disjoint by construction, so two schedule rows on the same weekday never
overlap and the service-layer rule from `docs/FEATURES/Schedules.md` is
satisfied without the seed having to check anything.

- [ ] **Step 2: Create the configuration file**

Create `src/database/seeds/seed.config.ts`:

```ts
export type TierName = 'popular' | 'busy' | 'regular' | 'quiet';

export interface ScheduleWindowSpec {
  startTime: string; // 'HH:mm:ss', clinic-local
  endTime: string;
}

export interface DoctorTier {
  name: TierName;
  doctors: number;
  /** 0 = Sunday .. 6 = Saturday, matching EXTRACT(DOW) and schedules.day_of_week. */
  workingDays: number[];
  windows: ScheduleWindowSpec[];
  slotDurationMinutes: 15 | 30 | 60;
  appointmentsPerDoctor: number;
}

export interface SeedConfig {
  scale: 'full' | 'small';
  randomSeed: number;
  patients: number;
  monthsPast: number;
  monthsFuture: number;
  cancelledFraction: number;
  /** Share of cancelled slots that get a second, CONFIRMED appointment. */
  rebookedFraction: number;
  /** Share of confirmed appointments recorded as created_from = WAITING_LIST. */
  waitingListSourceFraction: number;
  blocksPerDoctorPerYear: number;
  waitingListEntries: number;
  contestedReservoir: number;
  copyChunkRows: number;
  tiers: DoctorTier[];
}

/** Every seeded user shares this password. See the Global Constraints. */
export const SEED_PASSWORD = 'Password123!';

const TWO_WINDOW_DAY: ScheduleWindowSpec[] = [
  { startTime: '09:00:00', endTime: '13:00:00' },
  { startTime: '14:00:00', endTime: '18:00:00' },
];

export const FULL_SCALE: SeedConfig = {
  scale: 'full',
  randomSeed: 20260902,
  patients: 120_000,
  // 18 months of history gives the analytics query something to discriminate
  // on; 6 months of future gives the demo bookable and cancellable slots.
  monthsPast: 18,
  monthsFuture: 6,
  cancelledFraction: 0.15,
  rebookedFraction: 0.1,
  waitingListSourceFraction: 0.03,
  blocksPerDoctorPerYear: 10,
  waitingListEntries: 60_000,
  contestedReservoir: 20_000,
  copyChunkRows: 50_000,
  tiers: [
    {
      name: 'popular',
      doctors: 10,
      workingDays: [0, 1, 2, 3, 4, 5],
      windows: [
        { startTime: '08:00:00', endTime: '14:00:00' },
        { startTime: '15:00:00', endTime: '21:00:00' },
      ],
      slotDurationMinutes: 15,
      appointmentsPerDoctor: 24_000,
    },
    {
      name: 'busy',
      doctors: 40,
      workingDays: [0, 1, 2, 3, 4],
      windows: TWO_WINDOW_DAY,
      slotDurationMinutes: 15,
      appointmentsPerDoctor: 13_500,
    },
    {
      name: 'regular',
      doctors: 90,
      workingDays: [0, 1, 2, 3, 4],
      windows: TWO_WINDOW_DAY,
      slotDurationMinutes: 15,
      appointmentsPerDoctor: 11_000,
    },
    {
      name: 'quiet',
      doctors: 60,
      workingDays: [0, 1, 2, 3, 4],
      windows: [
        { startTime: '10:00:00', endTime: '13:00:00' },
        { startTime: '14:00:00', endTime: '17:00:00' },
      ],
      slotDurationMinutes: 30,
      appointmentsPerDoctor: 3_833,
    },
  ],
};

/**
 * About 1% of the data, loads in seconds.
 *
 * Used while iterating on the generators and while recording the screen demo —
 * a fifteen-minute seed on camera is fifteen minutes of dead air.
 */
export const SMALL_SCALE: SeedConfig = {
  ...FULL_SCALE,
  scale: 'small',
  patients: 2_000,
  waitingListEntries: 500,
  contestedReservoir: 1_000,
  copyChunkRows: 10_000,
  tiers: FULL_SCALE.tiers.map((tier) => ({
    ...tier,
    doctors: Math.max(2, Math.round(tier.doctors / 10)),
    appointmentsPerDoctor: Math.round(tier.appointmentsPerDoctor / 100),
  })),
};

export function resolveScale(argv: string[]): SeedConfig {
  return argv.includes('--scale=small') ? SMALL_SCALE : FULL_SCALE;
}
```

- [ ] **Step 3: Sanity-check the arithmetic**

```bash
node -e "const {FULL_SCALE}=require('ts-node').register()||require('./src/database/seeds/seed.config.ts');" 2>/dev/null || true
npx ts-node -e "import {FULL_SCALE} from './src/database/seeds/seed.config'; console.log(FULL_SCALE.tiers.reduce((n,t)=>n+t.doctors*t.appointmentsPerDoctor,0), FULL_SCALE.tiers.reduce((n,t)=>n+t.doctors,0));"
```

Expected: `1999980 200`.

- [ ] **Step 4: Commit**

```bash
git add src/database/seeds/seed.config.ts
git commit -m "feat(seed): define skewed doctor tiers and seed scales"
```

---

## Task 3: Patient occupancy tracking

This is the mechanism that keeps the seed from ever tripping
`appointments_patient_no_overlap`. Doctor-side safety comes free from drawing
each doctor's appointments out of their own non-overlapping slot grid; the
patient side needs an explicit structure, because one patient can be assigned
slots from 200 different doctors.

**Files:**
- Create: `src/database/seeds/occupancy.ts`
- Test: `src/database/seeds/occupancy.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class PatientOccupancy` with constructor
  `(epochMs: number, patientCount: number)` and methods
  `isFree(patientIndex: number, startAt: Date, endAt: Date): boolean` and
  `claim(patientIndex: number, startAt: Date, endAt: Date): void`.

- [ ] **Step 1: Write the failing test**

Create `src/database/seeds/occupancy.spec.ts`:

```ts
import { PatientOccupancy } from './occupancy';

const EPOCH = Date.parse('2026-01-01T00:00:00.000Z');

function at(iso: string): Date {
  return new Date(iso);
}

describe('PatientOccupancy', () => {
  it('reports a fresh patient as free', () => {
    const occupancy = new PatientOccupancy(EPOCH, 10);

    expect(occupancy.isFree(0, at('2026-03-01T09:00:00Z'), at('2026-03-01T09:30:00Z'))).toBe(true);
  });

  it('reports a claimed interval as busy', () => {
    const occupancy = new PatientOccupancy(EPOCH, 10);
    occupancy.claim(0, at('2026-03-01T09:00:00Z'), at('2026-03-01T09:30:00Z'));

    expect(occupancy.isFree(0, at('2026-03-01T09:00:00Z'), at('2026-03-01T09:30:00Z'))).toBe(false);
  });

  it('treats back-to-back intervals as free, matching the half-open range bound', () => {
    const occupancy = new PatientOccupancy(EPOCH, 10);
    occupancy.claim(0, at('2026-03-01T09:00:00Z'), at('2026-03-01T09:30:00Z'));

    expect(occupancy.isFree(0, at('2026-03-01T09:30:00Z'), at('2026-03-01T10:00:00Z'))).toBe(true);
  });

  it('detects a short interval nested inside a longer claim', () => {
    const occupancy = new PatientOccupancy(EPOCH, 10);
    occupancy.claim(0, at('2026-03-01T09:00:00Z'), at('2026-03-01T10:00:00Z'));

    expect(occupancy.isFree(0, at('2026-03-01T09:15:00Z'), at('2026-03-01T09:30:00Z'))).toBe(false);
  });

  it('detects a partial overlap at the start of a claim', () => {
    const occupancy = new PatientOccupancy(EPOCH, 10);
    occupancy.claim(0, at('2026-03-01T09:30:00Z'), at('2026-03-01T10:00:00Z'));

    expect(occupancy.isFree(0, at('2026-03-01T09:15:00Z'), at('2026-03-01T09:45:00Z'))).toBe(false);
  });

  it('keeps patients independent of each other', () => {
    const occupancy = new PatientOccupancy(EPOCH, 10);
    occupancy.claim(0, at('2026-03-01T09:00:00Z'), at('2026-03-01T09:30:00Z'));

    expect(occupancy.isFree(1, at('2026-03-01T09:00:00Z'), at('2026-03-01T09:30:00Z'))).toBe(true);
  });
});
```

The back-to-back test is the one that matters. If bucket membership were
inclusive of the end boundary, the generator would reject perfectly legal
consecutive appointments and, worse, would disagree with the `'[)'` bound the
database uses.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/database/seeds/occupancy.spec.ts`
Expected: FAIL — `Cannot find module './occupancy'`.

- [ ] **Step 3: Implement the occupancy set**

Create `src/database/seeds/occupancy.ts`:

```ts
const BUCKET_MINUTES = 15;
const BUCKET_MS = BUCKET_MINUTES * 60_000;

/**
 * Tracks which 15-minute buckets each patient already occupies.
 *
 * Every slot boundary the seed produces is a multiple of 15 minutes past the
 * hour and every allowed slot duration (15, 30, 60) is a multiple of 15, so
 * "the bucket sets are disjoint" is exactly "the half-open intervals do not
 * overlap" — the same test appointments_patient_no_overlap performs. There is
 * no approximation here, which is why the seed can load two million rows with
 * that constraint enabled and never trip it.
 *
 * Only CONFIRMED appointments are tracked. Both exclusion constraints are
 * partial on status = 'CONFIRMED', so cancelled rows are unconstrained and
 * deliberately neither check nor claim.
 */
export class PatientOccupancy {
  private readonly taken = new Set<number>();

  constructor(
    private readonly epochMs: number,
    private readonly patientCount: number,
  ) {}

  isFree(patientIndex: number, startAt: Date, endAt: Date): boolean {
    const [first, last] = this.bucketRange(startAt, endAt);

    for (let bucket = first; bucket < last; bucket += 1) {
      if (this.taken.has(this.key(patientIndex, bucket))) {
        return false;
      }
    }

    return true;
  }

  claim(patientIndex: number, startAt: Date, endAt: Date): void {
    const [first, last] = this.bucketRange(startAt, endAt);

    for (let bucket = first; bucket < last; bucket += 1) {
      this.taken.add(this.key(patientIndex, bucket));
    }
  }

  private bucketRange(startAt: Date, endAt: Date): [number, number] {
    return [
      Math.floor((startAt.getTime() - this.epochMs) / BUCKET_MS),
      Math.ceil((endAt.getTime() - this.epochMs) / BUCKET_MS),
    ];
  }

  private key(patientIndex: number, bucket: number): number {
    return bucket * this.patientCount + patientIndex;
  }
}
```

At full scale this Set holds roughly two million integers, about 200 MB of heap.
That is why the `seed` npm script raises `--max-old-space-size`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/database/seeds/occupancy.spec.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/database/seeds/occupancy.ts src/database/seeds/occupancy.spec.ts
git commit -m "feat(seed): track patient occupancy so generated rows never overlap"
```

---

## Task 4: People, schedules and blocks

**Files:**
- Create: `src/database/seeds/generators/people.generator.ts`
- Create: `src/database/seeds/generators/schedules.generator.ts`
- Test: `src/database/seeds/generators/schedules.generator.spec.ts`

**Interfaces:**
- Consumes: `Rng` and `encodeCopyRow` (Task 1); `DoctorTier`, `SeedConfig`,
  `SEED_PASSWORD` (Task 2); `UserRole` from
  `src/common/enums/role.enum.ts` (Plan 2).
- Produces:
  - `USER_COLUMNS`, `DOCTOR_COLUMNS`, `PATIENT_COLUMNS`,
    `SCHEDULE_COLUMNS`, `BLOCK_COLUMNS` — `string[]` column lists matching
    `docs/PLANS/00-interfaces.md`.
  - `interface SeededDoctor { id: string; userId: string; tier: TierName }`
  - `generatePeople(config, rng, passwordHash, now): { userRows: string[];
    doctorRows: string[]; patientRows: string[]; doctors: SeededDoctor[];
    patientIds: string[]; adminEmail: string }`
  - `interface ScheduleRow { id, doctorId, dayOfWeek, startTime, endTime,
    slotDurationMinutes }`
  - `interface BlockRow { id, doctorId, startAt, endAt, reason }`
  - `buildSchedules(doctorId, tier): ScheduleRow[]`
  - `buildBlocks(doctorId, config, rng, fromDate, toDate, timeZone): BlockRow[]`
  - `scheduleToCopyRow(row): string`, `blockToCopyRow(row): string`

- [ ] **Step 1: Write the people generator**

Create `src/database/seeds/generators/people.generator.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { UserRole } from '../../../common/enums/role.enum';
import { encodeCopyRow } from '../copy-writer';
import { Rng } from '../random';
import { DoctorTier, SeedConfig, TierName } from '../seed.config';

export const USER_COLUMNS = [
  'id',
  'first_name',
  'last_name',
  'email',
  'password_hash',
  'role',
  'created_at',
  'updated_at',
];

export const DOCTOR_COLUMNS = ['id', 'user_id', 'specialization', 'achievements'];

export const PATIENT_COLUMNS = [
  'id',
  'user_id',
  'phone_number',
  'date_of_birth',
  'gender',
  'has_insurance',
];

export interface SeededDoctor {
  id: string;
  userId: string;
  tier: TierName;
}

export interface GeneratedPeople {
  userRows: string[];
  doctorRows: string[];
  patientRows: string[];
  doctors: SeededDoctor[];
  patientIds: string[];
  adminEmail: string;
}

const SPECIALIZATIONS = [
  'Cardiology',
  'Dermatology',
  'Endocrinology',
  'Family Medicine',
  'Gastroenterology',
  'Neurology',
  'Obstetrics',
  'Ophthalmology',
  'Orthopaedics',
  'Paediatrics',
  'Psychiatry',
  'Pulmonology',
] as const;

const GENDERS = ['female', 'male', 'other'] as const;

const ADMIN_EMAIL = 'admin@clinic.test';

/**
 * All seeded users share one password hash.
 *
 * bcrypt at cost 10 takes 60-100 ms per hash by design. Hashing 120,000
 * distinct passwords would add two to three hours to the seed and demonstrate
 * nothing the auth unit tests do not already cover. One shared hash also means
 * the demo can log in as any seeded account.
 */
export function generatePeople(
  config: SeedConfig,
  rng: Rng,
  passwordHash: string,
  now: Date,
): GeneratedPeople {
  const userRows: string[] = [];
  const doctorRows: string[] = [];
  const patientRows: string[] = [];
  const doctors: SeededDoctor[] = [];
  const patientIds: string[] = [];

  const adminId = randomUUID();
  userRows.push(
    encodeCopyRow([
      adminId,
      'Clinic',
      'Admin',
      ADMIN_EMAIL,
      passwordHash,
      UserRole.Admin,
      now,
      now,
    ]),
  );

  let doctorNumber = 0;
  for (const tier of config.tiers) {
    for (let i = 0; i < tier.doctors; i += 1) {
      doctorNumber += 1;
      const userId = randomUUID();
      const doctorId = randomUUID();

      userRows.push(
        encodeCopyRow([
          userId,
          'Doctor',
          `Number${doctorNumber}`,
          `doctor${doctorNumber}@clinic.test`,
          passwordHash,
          UserRole.Doctor,
          now,
          now,
        ]),
      );
      doctorRows.push(
        encodeCopyRow([
          doctorId,
          userId,
          rng.pick(SPECIALIZATIONS),
          `${rng.int(2, 30)} years of practice`,
        ]),
      );
      doctors.push({ id: doctorId, userId, tier: tier.name });
    }
  }

  for (let i = 1; i <= config.patients; i += 1) {
    const userId = randomUUID();
    const patientId = randomUUID();

    userRows.push(
      encodeCopyRow([
        userId,
        'Patient',
        `Number${i}`,
        `patient${i}@clinic.test`,
        passwordHash,
        UserRole.Patient,
        now,
        now,
      ]),
    );
    patientRows.push(
      encodeCopyRow([
        patientId,
        userId,
        `+2010${String(10_000_000 + i).slice(0, 8)}`,
        `${rng.int(1950, 2008)}-${String(rng.int(1, 12)).padStart(2, '0')}-${String(
          rng.int(1, 28),
        ).padStart(2, '0')}`,
        rng.pick(GENDERS),
        rng.chance(0.45),
      ]),
    );
    patientIds.push(patientId);
  }

  return { userRows, doctorRows, patientRows, doctors, patientIds, adminEmail: ADMIN_EMAIL };
}

export function doctorTierOf(tiers: DoctorTier[], name: TierName): DoctorTier {
  const tier = tiers.find((candidate) => candidate.name === name);
  if (!tier) {
    throw new Error(`Unknown doctor tier: ${name}`);
  }
  return tier;
}
```

- [ ] **Step 2: Write the failing schedules and blocks test**

Create `src/database/seeds/generators/schedules.generator.spec.ts`:

```ts
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
```

The schedule overlap test enforces `docs/FEATURES/Schedules.md`: overlapping
schedule rows are rejected by the service layer, and seeded data that would have
been rejected through the API is data the API can never reproduce.

The block overlap test enforces the same idea one level harder. Overlapping
blocks are rejected by `blocks_no_overlap` (`docs/DECISIONS.md` #18), so a
generator that produced them would not write bad rows — it would fail the whole
seed with `23P01`. Several seeds are checked because a single one can miss a
collision by luck.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest src/database/seeds/generators/schedules.generator.spec.ts`
Expected: FAIL — `Cannot find module './schedules.generator'`.

- [ ] **Step 4: Implement the schedules and blocks generator**

Create `src/database/seeds/generators/schedules.generator.ts`:

```ts
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

export const BLOCK_COLUMNS = ['id', 'doctor_id', 'start_at', 'end_at', 'reason'];

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
export function buildSchedules(doctorId: string, tier: DoctorTier): ScheduleRow[] {
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
  const count = Math.max(1, Math.round((config.blocksPerDoctorPerYear * totalDays) / 365));

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
      : day.set({ hour: rng.int(9, 17), minute: rng.pick([0, 15, 30, 45]), second: 0, millisecond: 0 });
    const endAt = fullDay ? startAt.plus({ days: 1 }) : startAt.plus({ minutes: rng.pick([30, 60, 90]) });

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
  return encodeCopyRow([row.id, row.doctorId, row.startAt, row.endAt, row.reason]);
}
```

`DateTime.fromISO(..., { zone: timeZone }).startOf('day')` is what makes a
"vacation day" the clinic's calendar day rather than a UTC day, which matters in
`Africa/Cairo` across a DST boundary: the vacation is 23 or 25 hours long, and
that is correct.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/database/seeds/generators/schedules.generator.spec.ts`
Expected: PASS — 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/database/seeds/generators
git commit -m "feat(seed): generate users, doctors, patients, schedules and blocks"
```

---

## Task 5: The appointment generator

The centre of Part A. This is where the skew, the cancellations and both
overlap guarantees live.

**Files:**
- Create: `src/database/seeds/generators/appointments.generator.ts`
- Create: `src/database/seeds/generators/waiting-list.generator.ts`
- Test: `src/database/seeds/generators/appointments.generator.spec.ts`

**Interfaces:**
- Consumes: `generateSlots` and `Slot` from
  `src/availability/slot-generator.ts` (Plan 4); `AppointmentStatus`,
  `AppointmentSource`, `NotificationType`, `NotificationStatus`,
  `WaitingListStatus` from `src/common/enums/` (Plans 5–7);
  `REMINDER_LEAD_HOURS` from `src/common/constants.ts`; `PatientOccupancy`
  (Task 3); `Rng`, `encodeCopyRow` (Task 1); `ScheduleRow`, `BlockRow`
  (Task 4).
- Produces:
  - `APPOINTMENT_COLUMNS`, `NOTIFICATION_COLUMNS`, `WAITING_LIST_COLUMNS`
  - `interface ContestedSlot { doctorId: string; startAt: Date; endAt: Date }`
  - `interface AppointmentRecord { id, doctorId, patientId, startAt, endAt,
    status, appointmentRow, notificationRows }`
  - `interface DoctorPlan { doctorId, schedules, blocks, appointmentCount }`
  - `interface GeneratorContext { rng, now, fromDate, toDate, timeZone,
    patientIds, occupancy, config, contested }`
  - `sampleRecent(grid: Slot[], count: number, rng: Rng): Slot[]`
  - `generateDoctorAppointments(plan, ctx): Generator<AppointmentRecord>`
  - `generateWaitingList(ctx): string[]`

- [ ] **Step 1: Write the failing generator test**

Create `src/database/seeds/generators/appointments.generator.spec.ts`:

```ts
import { AppointmentStatus } from '../../../common/enums/appointment-status.enum';
import { PatientOccupancy } from '../occupancy';
import { Rng } from '../random';
import { SMALL_SCALE } from '../seed.config';
import { buildBlocks, buildSchedules } from './schedules.generator';
import {
  AppointmentRecord,
  GeneratorContext,
  generateDoctorAppointments,
} from './appointments.generator';

const TZ = 'Africa/Cairo';
const FROM = '2026-01-01';
const TO = '2026-06-30';
const NOW = new Date('2026-04-01T09:00:00Z');

function contextFor(patients: number, rng: Rng): GeneratorContext {
  return {
    rng,
    now: NOW,
    fromDate: FROM,
    toDate: TO,
    timeZone: TZ,
    patientIds: Array.from({ length: patients }, (_, i) => `patient-${i}`),
    occupancy: new PatientOccupancy(Date.parse(`${FROM}T00:00:00Z`), patients),
    config: SMALL_SCALE,
    contested: [],
  };
}

function overlaps(a: AppointmentRecord, b: AppointmentRecord): boolean {
  return a.startAt < b.endAt && b.startAt < a.endAt;
}

function collect(records: Iterable<AppointmentRecord>): AppointmentRecord[] {
  return [...records];
}

describe('generateDoctorAppointments', () => {
  const tier = SMALL_SCALE.tiers[1];

  it('never produces two overlapping CONFIRMED rows for the same doctor', () => {
    const rng = new Rng(101);
    const ctx = contextFor(500, rng);
    const records = collect(
      generateDoctorAppointments(
        {
          doctorId: 'doctor-1',
          schedules: buildSchedules('doctor-1', tier),
          blocks: buildBlocks('doctor-1', SMALL_SCALE, rng, FROM, TO, TZ),
          appointmentCount: tier.appointmentsPerDoctor,
        },
        ctx,
      ),
    );

    const confirmed = records
      .filter((record) => record.status === AppointmentStatus.Confirmed)
      .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());

    for (let i = 1; i < confirmed.length; i += 1) {
      expect(overlaps(confirmed[i - 1], confirmed[i])).toBe(false);
    }
  });

  it('never produces two overlapping CONFIRMED rows for the same patient', () => {
    const rng = new Rng(202);
    const ctx = contextFor(300, rng);
    const all: AppointmentRecord[] = [];

    for (let d = 0; d < 3; d += 1) {
      const doctorId = `doctor-${d}`;
      all.push(
        ...collect(
          generateDoctorAppointments(
            {
              doctorId,
              schedules: buildSchedules(doctorId, tier),
              blocks: buildBlocks(doctorId, SMALL_SCALE, rng, FROM, TO, TZ),
              appointmentCount: tier.appointmentsPerDoctor,
            },
            ctx,
          ),
        ),
      );
    }

    const byPatient = new Map<string, AppointmentRecord[]>();
    for (const record of all) {
      if (record.status !== AppointmentStatus.Confirmed) continue;
      const list = byPatient.get(record.patientId) ?? [];
      list.push(record);
      byPatient.set(record.patientId, list);
    }

    for (const list of byPatient.values()) {
      list.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
      for (let i = 1; i < list.length; i += 1) {
        expect(overlaps(list[i - 1], list[i])).toBe(false);
      }
    }
  });

  it('cancels roughly the configured share of appointments', () => {
    const rng = new Rng(303);
    const ctx = contextFor(500, rng);
    const records = collect(
      generateDoctorAppointments(
        {
          doctorId: 'doctor-1',
          schedules: buildSchedules('doctor-1', tier),
          blocks: buildBlocks('doctor-1', SMALL_SCALE, rng, FROM, TO, TZ),
          appointmentCount: tier.appointmentsPerDoctor,
        },
        ctx,
      ),
    );

    const cancelled = records.filter((r) => r.status === AppointmentStatus.Cancelled).length;
    const ratio = cancelled / records.length;

    expect(ratio).toBeGreaterThan(0.1);
    expect(ratio).toBeLessThan(0.2);
  });

  it('emits exactly one REMINDER notification per appointment', () => {
    const rng = new Rng(404);
    const ctx = contextFor(500, rng);
    const records = collect(
      generateDoctorAppointments(
        {
          doctorId: 'doctor-1',
          schedules: buildSchedules('doctor-1', tier),
          blocks: buildBlocks('doctor-1', SMALL_SCALE, rng, FROM, TO, TZ),
          appointmentCount: tier.appointmentsPerDoctor,
        },
        ctx,
      ),
    );

    for (const record of records) {
      const reminders = record.notificationRows.filter((row) => row.includes('REMINDER'));
      expect(reminders).toHaveLength(1);
    }
  });

  it('fails loudly when a tier asks for more appointments than the grid holds', () => {
    const rng = new Rng(505);
    const ctx = contextFor(50, rng);

    expect(() =>
      collect(
        generateDoctorAppointments(
          {
            doctorId: 'doctor-1',
            schedules: buildSchedules('doctor-1', tier),
            blocks: [],
            appointmentCount: 10_000_000,
          },
          ctx,
        ),
      ),
    ).toThrow(/only yields/);
  });
});
```

The first two tests are the plan's answer to "how does the seed avoid violating
the exclusion constraints". They assert exactly what the two constraints assert,
in memory, before two million rows are anywhere near a database.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/database/seeds/generators/appointments.generator.spec.ts`
Expected: FAIL — `Cannot find module './appointments.generator'`.

- [ ] **Step 3: Implement the appointment generator**

Create `src/database/seeds/generators/appointments.generator.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { Slot, generateSlots } from '../../../availability/slot-generator';
import { REMINDER_LEAD_HOURS } from '../../../common/constants';
import { AppointmentSource } from '../../../common/enums/appointment-source.enum';
import { AppointmentStatus } from '../../../common/enums/appointment-status.enum';
import { NotificationStatus } from '../../../common/enums/notification-status.enum';
import { NotificationType } from '../../../common/enums/notification-type.enum';
import { encodeCopyRow } from '../copy-writer';
import { PatientOccupancy } from '../occupancy';
import { Rng } from '../random';
import { SeedConfig } from '../seed.config';
import { BlockRow, ScheduleRow } from './schedules.generator';

export const APPOINTMENT_COLUMNS = [
  'id',
  'doctor_id',
  'patient_id',
  'start_at',
  'end_at',
  'status',
  'created_from',
  'created_at',
  'updated_at',
  'cancelled_at',
];

export const NOTIFICATION_COLUMNS = [
  'id',
  'appointment_id',
  'patient_id',
  'type',
  'status',
  'scheduled_at',
  'sent_at',
  'created_at',
];

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** How much denser the most recent month is than the oldest one. */
const RECENCY_WEIGHT_MAX = 2.5;

/** Random draws before falling back to a linear probe. */
const PATIENT_DRAW_ATTEMPTS = 20;

export interface ContestedSlot {
  doctorId: string;
  startAt: Date;
  endAt: Date;
}

export interface AppointmentRecord {
  id: string;
  doctorId: string;
  patientId: string;
  startAt: Date;
  endAt: Date;
  status: AppointmentStatus;
  appointmentRow: string;
  notificationRows: string[];
}

export interface DoctorPlan {
  doctorId: string;
  schedules: ScheduleRow[];
  blocks: BlockRow[];
  appointmentCount: number;
}

export interface GeneratorContext {
  rng: Rng;
  now: Date;
  fromDate: string;
  toDate: string;
  timeZone: string;
  patientIds: string[];
  occupancy: PatientOccupancy;
  config: SeedConfig;
  /** Future slots that already hold a confirmed appointment; waiting lists form here. */
  contested: ContestedSlot[];
}

/**
 * Weighted sampling without replacement (Efraimidis-Spirakis): each candidate
 * gets key = u^(1/w) and the highest k keys win.
 *
 * The weight rises linearly towards the end of the seed window, so recent
 * months are denser than old ones. Without it every month would hold the same
 * number of appointments and the monthly analytics query would return the same
 * figure twenty-four times, which would tell a reader nothing.
 */
export function sampleRecent(grid: Slot[], count: number, rng: Rng): Slot[] {
  const first = grid[0].startAt.getTime();
  const span = Math.max(1, grid[grid.length - 1].startAt.getTime() - first);

  const keyed = grid.map((slot) => {
    const position = (slot.startAt.getTime() - first) / span;
    const weight = 1 + position * (RECENCY_WEIGHT_MAX - 1);
    return { slot, key: Math.pow(rng.next(), 1 / weight) };
  });

  keyed.sort((a, b) => b.key - a.key);
  return keyed.slice(0, count).map((entry) => entry.slot);
}

/**
 * Generates one doctor's appointments, and the notification row that booking
 * would have written alongside each of them.
 *
 * Doctor-side overlap is impossible by construction: every appointment is
 * drawn from this doctor's own slot grid, the grid's slots are consecutive
 * half-open intervals, and sampling is without replacement, so no two chosen
 * slots can overlap. Patient-side overlap is prevented by claiming the
 * patient's 15-minute buckets before the row is emitted. Between them the two
 * exclusion constraints cannot fire, which is why they stay enabled during the
 * load.
 */
export function* generateDoctorAppointments(
  plan: DoctorPlan,
  ctx: GeneratorContext,
): Generator<AppointmentRecord> {
  const grid = generateSlots({
    fromDate: ctx.fromDate,
    toDate: ctx.toDate,
    timeZone: ctx.timeZone,
    schedules: plan.schedules.map((schedule) => ({
      dayOfWeek: schedule.dayOfWeek,
      startTime: schedule.startTime,
      endTime: schedule.endTime,
      slotDurationMinutes: schedule.slotDurationMinutes,
    })),
    blocks: plan.blocks.map((block) => ({ startAt: block.startAt, endAt: block.endAt })),
    booked: [],
  });

  if (grid.length < plan.appointmentCount) {
    throw new Error(
      `Doctor ${plan.doctorId} was asked for ${plan.appointmentCount} appointments but ` +
        `their schedule only yields ${grid.length} slots over ${ctx.fromDate}..${ctx.toDate}. ` +
        `Lower appointmentsPerDoctor or widen the tier's windows in seed.config.ts.`,
    );
  }

  const chosen = sampleRecent(grid, plan.appointmentCount, ctx.rng);
  // Time order gives the GiST index better insert locality than random order.
  chosen.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());

  for (const slot of chosen) {
    if (ctx.rng.chance(ctx.config.cancelledFraction)) {
      // Both exclusion constraints are partial on status = 'CONFIRMED', so a
      // cancelled row is unconstrained: it neither checks nor claims occupancy.
      const patientIndex = ctx.rng.int(0, ctx.patientIds.length - 1);
      yield buildRecord(plan.doctorId, slot, patientIndex, AppointmentStatus.Cancelled, ctx);

      // A cancelled slot can legitimately be booked again. Generating some of
      // those pairs is what proves the constraints really are partial rather
      // than merely documented as such.
      if (ctx.rng.chance(ctx.config.rebookedFraction)) {
        const rebooker = claimFreePatient(slot, ctx);
        yield buildRecord(plan.doctorId, slot, rebooker, AppointmentStatus.Confirmed, ctx);
        rememberContested(plan.doctorId, slot, ctx);
      }
      continue;
    }

    const patientIndex = claimFreePatient(slot, ctx);
    yield buildRecord(plan.doctorId, slot, patientIndex, AppointmentStatus.Confirmed, ctx);
    rememberContested(plan.doctorId, slot, ctx);
  }
}

/**
 * Finds a patient with no confirmed appointment overlapping this slot.
 *
 * Termination: at most one doctor can hold this instant per doctor, so at most
 * `doctors` patients out of `patients` are busy at any moment — 200 out of
 * 120,000 at full scale. A few random draws almost always succeed, and the
 * linear probe is a guarantee rather than a hot path.
 */
function claimFreePatient(slot: Slot, ctx: GeneratorContext): number {
  const total = ctx.patientIds.length;

  for (let attempt = 0; attempt < PATIENT_DRAW_ATTEMPTS; attempt += 1) {
    const candidate = ctx.rng.int(0, total - 1);
    if (ctx.occupancy.isFree(candidate, slot.startAt, slot.endAt)) {
      ctx.occupancy.claim(candidate, slot.startAt, slot.endAt);
      return candidate;
    }
  }

  let index = ctx.rng.int(0, total - 1);
  for (let step = 0; step < total; step += 1) {
    if (ctx.occupancy.isFree(index, slot.startAt, slot.endAt)) {
      ctx.occupancy.claim(index, slot.startAt, slot.endAt);
      return index;
    }
    index = (index + 1) % total;
  }

  throw new Error(
    `Every seeded patient is already busy at ${slot.startAt.toISOString()}. ` +
      `Raise SeedConfig.patients.`,
  );
}

function rememberContested(doctorId: string, slot: Slot, ctx: GeneratorContext): void {
  if (slot.startAt <= ctx.now || ctx.contested.length >= ctx.config.contestedReservoir) {
    return;
  }
  // Sample rather than collect everything: the reservoir only needs enough
  // distinct future slots to hang the waiting-list entries on.
  if (ctx.rng.chance(0.02)) {
    ctx.contested.push({ doctorId, startAt: slot.startAt, endAt: slot.endAt });
  }
}

function buildRecord(
  doctorId: string,
  slot: Slot,
  patientIndex: number,
  status: AppointmentStatus,
  ctx: GeneratorContext,
): AppointmentRecord {
  const id = randomUUID();
  const patientId = ctx.patientIds[patientIndex];

  const createdAt = new Date(slot.startAt.getTime() - ctx.rng.int(1, 30) * DAY_MS);
  const cancelledAt =
    status === AppointmentStatus.Cancelled
      ? new Date(
          createdAt.getTime() + ctx.rng.next() * (slot.startAt.getTime() - createdAt.getTime()),
        )
      : null;

  const fromWaitingList =
    status === AppointmentStatus.Confirmed &&
    ctx.rng.chance(ctx.config.waitingListSourceFraction);

  const appointmentRow = encodeCopyRow([
    id,
    doctorId,
    patientId,
    slot.startAt,
    slot.endAt,
    status,
    fromWaitingList ? AppointmentSource.WaitingList : AppointmentSource.Direct,
    createdAt,
    cancelledAt ?? createdAt,
    cancelledAt,
  ]);

  // Booking writes the PENDING reminder row inside the same transaction as the
  // appointment (docs/API.md), so every appointment has exactly one, including
  // ones that were later cancelled.
  const reminderAt = new Date(slot.startAt.getTime() - REMINDER_LEAD_HOURS * HOUR_MS);
  const reminderSent =
    reminderAt <= ctx.now && (cancelledAt === null || cancelledAt > reminderAt);

  const notificationRows = [
    encodeCopyRow([
      randomUUID(),
      id,
      patientId,
      NotificationType.Reminder,
      reminderSent ? NotificationStatus.Sent : NotificationStatus.Pending,
      reminderAt,
      reminderSent ? reminderAt : null,
      createdAt,
    ]),
  ];

  if (fromWaitingList) {
    notificationRows.push(
      encodeCopyRow([
        randomUUID(),
        id,
        patientId,
        NotificationType.WaitlistAssigned,
        NotificationStatus.Sent,
        createdAt,
        createdAt,
        createdAt,
      ]),
    );
  }

  return {
    id,
    doctorId,
    patientId,
    startAt: slot.startAt,
    endAt: slot.endAt,
    status,
    appointmentRow,
    notificationRows,
  };
}
```

Reusing `generateSlots()` rather than writing a second expander is deliberate.
It means every seeded appointment sits exactly on the grid the availability
endpoint will offer, so a patient browsing seeded data sees slots that line up
with seeded appointments. Two independent expanders would eventually disagree
about a DST boundary and the mismatch would only surface as an odd-looking demo.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/database/seeds/generators/appointments.generator.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Implement the waiting-list generator**

Create `src/database/seeds/generators/waiting-list.generator.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { WaitingListStatus } from '../../../common/enums/waiting-list-status.enum';
import { encodeCopyRow } from '../copy-writer';
import { Rng } from '../random';
import { SeedConfig } from '../seed.config';
import { ContestedSlot } from './appointments.generator';

export const WAITING_LIST_COLUMNS = [
  'id',
  'doctor_id',
  'patient_id',
  'slot_start_at',
  'slot_end_at',
  'status',
  'expires_at',
  'created_at',
  'updated_at',
];

const DAY_MS = 86_400_000;

/**
 * Hangs waiting-list entries on slots that already hold a confirmed
 * appointment, because that is the only place a queue can form.
 *
 * waiting_list_one_active is a partial unique index on
 * (doctor_id, patient_id, slot_start_at) WHERE status = 'WAITING', so the
 * generator tracks the WAITING triples it has already emitted and skips
 * duplicates rather than relying on the odds.
 */
export function generateWaitingList(
  contested: ContestedSlot[],
  patientIds: string[],
  config: SeedConfig,
  rng: Rng,
  now: Date,
): string[] {
  if (contested.length === 0) {
    return [];
  }

  const rows: string[] = [];
  const activeKeys = new Set<string>();

  while (rows.length < config.waitingListEntries) {
    const slot = rng.pick(contested);
    const patientId = rng.pick(patientIds);

    // 70% still waiting, 20% expired, 8% assigned, 2% withdrawn.
    const roll = rng.next();
    const status =
      roll < 0.7
        ? WaitingListStatus.Waiting
        : roll < 0.9
          ? WaitingListStatus.Expired
          : roll < 0.98
            ? WaitingListStatus.Assigned
            : WaitingListStatus.Cancelled;

    if (status === WaitingListStatus.Waiting) {
      const key = `${slot.doctorId}|${patientId}|${slot.startAt.toISOString()}`;
      if (activeKeys.has(key)) {
        continue;
      }
      activeKeys.add(key);
    }

    const createdAt = new Date(slot.startAt.getTime() - rng.int(2, 45) * DAY_MS);
    // expires_at must be before slot_start_at (docs/FEATURES/WaitingList.md).
    const expiresAt = rng.chance(0.3)
      ? new Date(slot.startAt.getTime() - rng.int(1, 2) * DAY_MS)
      : null;

    rows.push(
      encodeCopyRow([
        randomUUID(),
        slot.doctorId,
        patientId,
        slot.startAt,
        slot.endAt,
        status,
        expiresAt,
        createdAt,
        status === WaitingListStatus.Waiting ? createdAt : now,
      ]),
    );
  }

  return rows;
}
```

- [ ] **Step 6: Run the whole seed unit suite**

Run: `npx jest src/database/seeds`
Expected: PASS — 28 tests across `random`, `copy-writer`, `occupancy`,
`schedules.generator` and `appointments.generator`.

- [ ] **Step 7: Commit**

```bash
git add src/database/seeds/generators
git commit -m "feat(seed): generate skewed appointment data without overlaps"
```

---

## Task 6: The seed entry point, the compose profile, and the measured runtime

**Files:**
- Create: `src/database/seeds/phase-timer.ts`
- Create: `src/database/seeds/seed.ts`
- Modify: `package.json`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: everything from Tasks 1–5; `DATABASE_URL` and `CLINIC_TZ` from
  Plan 1's `.env`; the migrated schema from Plan 1's `migrate` service.
- Produces: `npm run seed`, `npm run seed:small`, `npm run seed:reset`, and the
  `seed` compose profile. Part B measures against what this produces.

- [ ] **Step 1: Write the phase timer**

Create `src/database/seeds/phase-timer.ts`:

```ts
interface Phase {
  name: string;
  rows: number;
  ms: number;
}

/**
 * Prints where the seed's time actually went.
 *
 * "The seed takes about fifteen minutes" is not a useful claim without knowing
 * which phase owns those minutes, and the README quotes a measured number.
 */
export class PhaseTimer {
  private readonly phases: Phase[] = [];

  async run<T>(name: string, rows: () => number | Promise<number>, work: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    const result = await work();
    this.phases.push({ name, rows: await rows(), ms: Date.now() - startedAt });
    return result;
  }

  report(): string {
    const totalMs = this.phases.reduce((sum, phase) => sum + phase.ms, 0);
    const totalRows = this.phases.reduce((sum, phase) => sum + phase.rows, 0);

    const lines = [
      'phase                       rows        seconds      rows/s',
      '----------------------------------------------------------',
      ...this.phases.map(
        (phase) =>
          `${phase.name.padEnd(24)}${String(phase.rows).padStart(10)}` +
          `${(phase.ms / 1000).toFixed(1).padStart(15)}` +
          `${Math.round(phase.rows / Math.max(phase.ms / 1000, 0.001))
            .toString()
            .padStart(12)}`,
      ),
      '----------------------------------------------------------',
      `${'TOTAL'.padEnd(24)}${String(totalRows).padStart(10)}${(totalMs / 1000).toFixed(1).padStart(15)}`,
    ];

    return lines.join('\n');
  }
}
```

- [ ] **Step 2: Write the seed entry point**

Create `src/database/seeds/seed.ts`:

```ts
import 'reflect-metadata';
import * as bcrypt from 'bcrypt';
import { config as loadDotenv } from 'dotenv';
import { DateTime } from 'luxon';
import { Pool, PoolClient } from 'pg';
import { copyRows } from './copy-writer';
import {
  APPOINTMENT_COLUMNS,
  AppointmentRecord,
  ContestedSlot,
  GeneratorContext,
  NOTIFICATION_COLUMNS,
  generateDoctorAppointments,
} from './generators/appointments.generator';
import {
  DOCTOR_COLUMNS,
  PATIENT_COLUMNS,
  USER_COLUMNS,
  doctorTierOf,
  generatePeople,
} from './generators/people.generator';
import {
  BLOCK_COLUMNS,
  SCHEDULE_COLUMNS,
  blockToCopyRow,
  buildBlocks,
  buildSchedules,
  scheduleToCopyRow,
} from './generators/schedules.generator';
import {
  WAITING_LIST_COLUMNS,
  generateWaitingList,
} from './generators/waiting-list.generator';
import { PatientOccupancy } from './occupancy';
import { PhaseTimer } from './phase-timer';
import { Rng } from './random';
import { SEED_PASSWORD, resolveScale } from './seed.config';

const TRUNCATE_ORDER =
  'notifications, waiting_list, appointments, blocks, schedules, patients, doctors, users';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required to run the seed`);
  }
  return value;
}

async function assertSafeToSeed(client: PoolClient, reset: boolean): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed with NODE_ENV=production');
  }

  const { rows } = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM appointments',
  );

  if (rows[0].count === '0') {
    return;
  }

  if (!reset) {
    throw new Error(
      `appointments already holds ${rows[0].count} rows. Seeding on top would double the ` +
        `dataset and invalidate every recorded EXPLAIN ANALYZE. Re-run with --reset to wipe first.`,
    );
  }

  await client.query(`TRUNCATE ${TRUNCATE_ORDER} RESTART IDENTITY CASCADE`);
}

async function main(): Promise<void> {
  loadDotenv();

  const config = resolveScale(process.argv);
  const reset = process.argv.includes('--reset');
  const timeZone = requireEnv('CLINIC_TZ');
  const now = new Date();

  const fromDate = DateTime.fromJSDate(now, { zone: timeZone })
    .minus({ months: config.monthsPast })
    .startOf('month')
    .toISODate() as string;
  const toDate = DateTime.fromJSDate(now, { zone: timeZone })
    .plus({ months: config.monthsFuture })
    .endOf('month')
    .toISODate() as string;

  const pool = new Pool({ connectionString: requireEnv('DATABASE_URL'), max: 1 });
  const client = await pool.connect();
  const timer = new PhaseTimer();

  try {
    // Safe for a seed: the only thing at risk from a crash is the seed itself,
    // which is re-runnable. It removes one fsync per chunk commit, which is the
    // single largest lever on total runtime.
    await client.query('SET synchronous_commit = off');
    await assertSafeToSeed(client, reset);

    const rng = new Rng(config.randomSeed);
    const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);
    const people = generatePeople(config, rng, passwordHash, now);

    await timer.run(
      'users',
      () => people.userRows.length,
      () => copyRows(client, 'users', USER_COLUMNS, people.userRows),
    );
    await timer.run(
      'doctors',
      () => people.doctorRows.length,
      () => copyRows(client, 'doctors', DOCTOR_COLUMNS, people.doctorRows),
    );
    await timer.run(
      'patients',
      () => people.patientRows.length,
      () => copyRows(client, 'patients', PATIENT_COLUMNS, people.patientRows),
    );

    const plans = people.doctors.map((doctor) => {
      const tier = doctorTierOf(config.tiers, doctor.tier);
      return {
        doctorId: doctor.id,
        schedules: buildSchedules(doctor.id, tier),
        blocks: buildBlocks(doctor.id, config, rng, fromDate, toDate, timeZone),
        appointmentCount: tier.appointmentsPerDoctor,
      };
    });

    await timer.run(
      'schedules',
      () => plans.reduce((n, plan) => n + plan.schedules.length, 0),
      () =>
        copyRows(
          client,
          'schedules',
          SCHEDULE_COLUMNS,
          plans.flatMap((plan) => plan.schedules.map(scheduleToCopyRow)),
        ),
    );
    await timer.run(
      'blocks',
      () => plans.reduce((n, plan) => n + plan.blocks.length, 0),
      () =>
        copyRows(
          client,
          'blocks',
          BLOCK_COLUMNS,
          plans.flatMap((plan) => plan.blocks.map(blockToCopyRow)),
        ),
    );

    const contested: ContestedSlot[] = [];
    const ctx: GeneratorContext = {
      rng,
      now,
      fromDate,
      toDate,
      timeZone,
      patientIds: people.patientIds,
      occupancy: new PatientOccupancy(Date.parse(`${fromDate}T00:00:00Z`), people.patientIds.length),
      config,
      contested,
    };

    let appointmentCount = 0;
    let notificationCount = 0;

    await timer.run(
      'appointments+notifs',
      () => appointmentCount + notificationCount,
      async () => {
        let appointmentChunk: string[] = [];
        let notificationChunk: string[] = [];

        const flush = async (): Promise<void> => {
          if (appointmentChunk.length === 0) {
            return;
          }
          // One transaction per chunk. Notifications reference appointments by
          // foreign key, so they must land in the same transaction as the rows
          // they point at.
          await client.query('BEGIN');
          await copyRows(client, 'appointments', APPOINTMENT_COLUMNS, appointmentChunk);
          await copyRows(client, 'notifications', NOTIFICATION_COLUMNS, notificationChunk);
          await client.query('COMMIT');

          appointmentCount += appointmentChunk.length;
          notificationCount += notificationChunk.length;
          process.stdout.write(`  ${appointmentCount} appointments\r`);
          appointmentChunk = [];
          notificationChunk = [];
        };

        for (const plan of plans) {
          for (const record of generateDoctorAppointments(plan, ctx)) {
            appointmentChunk.push(record.appointmentRow);
            notificationChunk.push(...record.notificationRows);
            if (appointmentChunk.length >= config.copyChunkRows) {
              await flush();
            }
          }
        }

        await flush();
        process.stdout.write('\n');
      },
    );

    const waitingListRows = generateWaitingList(contested, people.patientIds, config, rng, now);
    await timer.run(
      'waiting_list',
      () => waitingListRows.length,
      () => copyRows(client, 'waiting_list', WAITING_LIST_COLUMNS, waitingListRows),
    );

    // ANALYZE gives the planner statistics; without it the first EXPLAIN
    // ANALYZE measures a planner guessing from defaults. VACUUM additionally
    // sets the visibility map, without which an "index only" scan still reads
    // every heap page and understates what the index is worth.
    await timer.run(
      'vacuum analyze',
      () => 0,
      async () => {
        await client.query('VACUUM (ANALYZE) users');
        await client.query('VACUUM (ANALYZE) doctors');
        await client.query('VACUUM (ANALYZE) patients');
        await client.query('VACUUM (ANALYZE) schedules');
        await client.query('VACUUM (ANALYZE) blocks');
        await client.query('VACUUM (ANALYZE) appointments');
        await client.query('VACUUM (ANALYZE) notifications');
        await client.query('VACUUM (ANALYZE) waiting_list');
      },
    );

    const busiest = await client.query<{ doctor_id: string; appointments: string }>(
      `SELECT doctor_id, count(*)::text AS appointments
         FROM appointments GROUP BY doctor_id ORDER BY count(*) DESC LIMIT 3`,
    );

    console.log(`\n${timer.report()}\n`);
    console.log(`scale            : ${config.scale}`);
    console.log(`window           : ${fromDate} .. ${toDate} (${timeZone})`);
    console.log(`login password   : ${SEED_PASSWORD}`);
    console.log(`admin account    : ${people.adminEmail}`);
    console.log('busiest doctors  :');
    for (const row of busiest.rows) {
      console.log(`  ${row.doctor_id}  ${row.appointments}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 3: Add the npm scripts**

Add to `"scripts"` in `package.json`:

```json
"seed": "node --max-old-space-size=4096 -r ts-node/register -r tsconfig-paths/register src/database/seeds/seed.ts",
"seed:small": "node -r ts-node/register -r tsconfig-paths/register src/database/seeds/seed.ts --scale=small",
"seed:reset": "node --max-old-space-size=4096 -r ts-node/register -r tsconfig-paths/register src/database/seeds/seed.ts --reset"
```

A CLI flag rather than an environment variable, because `SEED_SCALE=small npm
run seed` is not valid syntax in PowerShell and this project is developed on
Windows.

- [ ] **Step 4: Run the small seed and check it end to end**

```bash
docker compose up -d postgres redis
npm run seed:small
```

Expected: a phase table, then a summary. Roughly 20 doctors, 2,000 patients and
about 5,800 appointments, completing in under 30 seconds. Any SQLSTATE `23P01`
here is a generator bug, not a configuration problem — the constraint is doing
exactly the job it was added for.

- [ ] **Step 5: Verify the small dataset satisfies the invariants**

```bash
docker compose exec postgres psql -U clinic -d clinic -c "SELECT count(*) AS appointments, count(*) FILTER (WHERE status='CANCELLED') AS cancelled, count(DISTINCT doctor_id) AS doctors FROM appointments;"
docker compose exec postgres psql -U clinic -d clinic -c "SELECT min(c) AS quietest, max(c) AS busiest FROM (SELECT count(*) c FROM appointments GROUP BY doctor_id) x;"
docker compose exec postgres psql -U clinic -d clinic -c "SELECT count(*) FROM appointments a WHERE a.start_at > now();"
```

Expected: `doctors` = 20; `cancelled` is 13–17% of `appointments`; `busiest` is
at least four times `quietest`; the future count is greater than zero.

- [ ] **Step 6: Run the full seed and record the real runtime**

```bash
npm run seed:reset
```

Expected shape of the output — the *numbers* here are what this step exists to
discover, and they go into the README:

```text
phase                       rows        seconds      rows/s
----------------------------------------------------------
users                     120201            ...         ...
doctors                      200            ...         ...
patients                  120000            ...         ...
schedules                   2140            ...         ...
blocks                      4000            ...         ...
appointments+notifs      4100000            ...         ...
waiting_list               60000            ...         ...
vacuum analyze                 0            ...         ...
----------------------------------------------------------
TOTAL                    4406541            ...
```

What to expect before you run it, so you can tell success from a stall: on a
developer laptop running Docker Desktop with 4 CPUs and 8 GB, the
`appointments+notifs` phase takes roughly **4 to 12 minutes** and the whole seed
roughly **8 to 20 minutes**. If it passes 30 minutes something is wrong — check
that `SET synchronous_commit = off` actually applied, that the Docker VM has not
been given 2 GB of memory, and that the host disk is not a spinning drive.

For comparison, the alternatives that were rejected:

| Strategy | Estimated time for 2M appointment rows | Why not |
|---|---|---|
| `repository.save()` per row | 1.5–3 hours | One round trip and one transaction per row, plus TypeORM entity hydration. |
| `repository.insert()` in batches | 25–45 min | Better, but PostgreSQL caps a statement at 65535 bind parameters, so a 10-column insert tops out near 6500 rows and each statement still parses and plans. |
| **`COPY ... FROM STDIN`** | **4–12 min** | One parse, no parameter limit, minimal protocol overhead. Costs one dev dependency. |
| `COPY` with constraints dropped and rebuilt | 3–8 min | Faster, and rejected. Dropping the project's central invariant inside its own seed script is the wrong thing to demonstrate, the GiST rebuild claws back most of the saving, and a generator bug would surface as one opaque failure at the end instead of at the offending row. |

- [ ] **Step 7: Verify the full dataset**

```bash
docker compose exec postgres psql -U clinic -d clinic -c "SELECT count(*) AS appointments, round(100.0*count(*) FILTER (WHERE status='CANCELLED')/count(*),1) AS cancelled_pct, count(DISTINCT doctor_id) AS doctors FROM appointments;"
docker compose exec postgres psql -U clinic -d clinic -c "SELECT min(c) AS quietest, percentile_disc(0.5) WITHIN GROUP (ORDER BY c) AS median, max(c) AS busiest FROM (SELECT count(*) c FROM appointments GROUP BY doctor_id) x;"
docker compose exec postgres psql -U clinic -d clinic -c "SELECT count(*) FROM notifications;"
docker compose exec postgres psql -U clinic -d clinic -c "SELECT status, count(*) FROM waiting_list GROUP BY status ORDER BY 2 DESC;"
docker compose exec postgres psql -U clinic -d clinic -c "SELECT pg_size_pretty(pg_total_relation_size('appointments'));"
```

Expected: `appointments` between 2,020,000 and 2,045,000; `cancelled_pct`
between 14.5 and 15.5; `doctors` = 200; `busiest` around 24,000 and `quietest`
around 3,800; `notifications` a little above the appointment count;
`waiting_list` showing all four statuses with WAITING largest.

- [ ] **Step 8: Prove no doctor overlap survived, for the busiest doctor**

The two exclusion constraints already guarantee this — a violation would have
aborted the load. Run the self-join anyway on one doctor, because a check that
costs three seconds and can only ever return `0` is worth having in the
transcript:

```bash
docker compose exec postgres psql -U clinic -d clinic -c "SELECT doctor_id FROM appointments GROUP BY doctor_id ORDER BY count(*) DESC LIMIT 1" -t -A
```

Then, substituting the id printed above:

```bash
docker compose exec postgres psql -U clinic -d clinic -c "SELECT count(*) AS overlapping_pairs FROM appointments a JOIN appointments b ON a.doctor_id=b.doctor_id AND a.id<b.id AND a.status='CONFIRMED' AND b.status='CONFIRMED' AND tstzrange(a.start_at,a.end_at,'[)') && tstzrange(b.start_at,b.end_at,'[)') WHERE a.doctor_id='<paste id>';"
```

Expected: `overlapping_pairs` = 0.

- [ ] **Step 9: Add the `seed` compose service and the perf mount**

In `docker-compose.yml`, add the read-only mount to the existing `postgres`
service (Part B reads its SQL from there):

```yaml
  postgres:
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./scripts/perf:/perf:ro
```

And add the new service before the `volumes:` block:

```yaml
  seed:
    build:
      context: .
      target: migrate
    profiles: ['seed']
    environment:
      NODE_ENV: development
      DATABASE_URL: postgres://clinic:clinic@postgres:5432/clinic
      CLINIC_TZ: ${CLINIC_TZ}
    command: ['npm', 'run', 'seed:reset']
    depends_on:
      postgres:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    restart: 'no'
```

It reuses the `migrate` build target because that stage already has the
TypeScript sources and dev dependencies the seed needs, and it sits behind a
profile because a fifteen-minute job has no business running on
`docker compose up` (`docs/INFRASTRUCTURE/Deployment.md`).

- [ ] **Step 10: Run the seed through compose**

```bash
docker compose down -v
docker compose up --build -d
docker compose --profile seed up seed
```

Expected: the `seed` container prints the same phase table and exits 0.
`docker compose ps -a` shows `seed` as `exited (0)`.

- [ ] **Step 11: Commit**

```bash
git add package.json docker-compose.yml src/database/seeds
git commit -m "feat(seed): add seed entry point, npm scripts and compose profile"
```

---

## Task 7: The performance evidence harness

Part B begins. This task builds the scripts; Task 8 runs them and writes down
what they said.

**Files:**
- Create: `scripts/perf/00-context.sql`
- Create: `scripts/perf/01-availability.sql`
- Create: `scripts/perf/02-patient-appointments.sql`
- Create: `scripts/perf/03-analytics-month.sql`
- Create: `scripts/perf/04-blocks.sql`
- Create: `scripts/perf/05-waiting-list.sql`
- Create: `scripts/perf/06-notifications.sql`
- Create: `scripts/perf/explain-evidence.sql`

**Interfaces:**
- Consumes: the seeded database from Task 6; the index and constraint names
  created by Plans 5–7.
- Produces: a single command that emits every before/after plan in one
  reproducible transcript.

- [ ] **Step 1: Confirm the index names before writing anything against them**

```bash
docker compose exec postgres psql -U clinic -d clinic -c "\di+ appointments*"
docker compose exec postgres psql -U clinic -d clinic -c "\di+ blocks*"
docker compose exec postgres psql -U clinic -d clinic -c "\di+ waiting_list*"
docker compose exec postgres psql -U clinic -d clinic -c "\di+ notifications*"
```

The scripts below use these names:

| Object | Kind | Table | Named query it exists for |
|---|---|---|---|
| `appointments_no_overlap` | EXCLUDE (GiST, partial) | appointments | Q1 taken slots for a doctor in a date range |
| `appointments_patient_no_overlap` | EXCLUDE (GiST, partial) | appointments | backstop for Q2's pre-check |
| `appointments_patient_start_at_idx` | btree | appointments | Q2 "list my appointments" and the cancel ownership check |
| `appointments_doctor_start_at_idx` | btree | appointments | Q3 monthly analytics, which must count cancelled rows |
| `blocks_doctor_time_idx` | btree | blocks | Q4 block subtraction during slot generation |
| `blocks_no_overlap` | EXCLUDE (GiST) | blocks | invariant only: one period of unavailability per row |
| `waiting_list_doctor_slot_status_idx` | btree | waiting_list | Q5 assignment job and sweeper |
| `waiting_list_one_active` | UNIQUE btree, partial | waiting_list | Q6 "am I already in this queue?" |
| `notifications_unique_per_type` | UNIQUE constraint | notifications | Q7 job idempotency lookup |
| `notifications_pending_due_idx` | btree, partial | notifications | Q8 sweeper finding due-but-unsent |

If `\di+` disagrees with this table, the database is right. Update the names in
the scripts below and in the README index table to match, and note the
divergence in `docs/PLANS/00-interfaces.md` so the next reader is not misled.

- [ ] **Step 2: Write the context script**

Create `scripts/perf/00-context.sql`:

```sql
-- Picks the rows every later script measures against, and echoes them, so the
-- captured transcript records exactly which doctor, patient, month and slot
-- produced the numbers. Re-running the seed with the same randomSeed
-- reproduces the same choices.
--
-- Deliberately the busiest doctor, not an average one. docs/TESTING.md: the
-- query plan for the busiest doctor is the one that has to stay fast, and it is
-- the number worth reporting.

\set tz 'Africa/Cairo'

-- JIT compilation adds tens of milliseconds of variance to large sequential
-- scans and none to index lookups, which would flatter the index unfairly.
SET jit = off;

SELECT doctor_id AS busy_doctor
FROM appointments
GROUP BY doctor_id
ORDER BY count(*) DESC
LIMIT 1 \gset

SELECT patient_id AS busy_patient
FROM appointments
GROUP BY patient_id
ORDER BY count(*) DESC
LIMIT 1 \gset

SELECT id AS sample_appointment
FROM appointments
WHERE doctor_id = :'busy_doctor'
ORDER BY start_at DESC
LIMIT 1 \gset

SELECT to_char(date_trunc('month', start_at AT TIME ZONE :'tz'), 'YYYY-MM-DD') AS busy_month
FROM appointments
WHERE doctor_id = :'busy_doctor'
GROUP BY 1
ORDER BY count(*) DESC
LIMIT 1 \gset

SELECT (:'busy_month'::timestamp AT TIME ZONE :'tz')::text AS month_start,
       ((:'busy_month'::timestamp + interval '1 month') AT TIME ZONE :'tz')::text AS month_end
\gset

SELECT now()::text AS win_from,
       (now() + interval '30 days')::text AS win_to
\gset

SELECT doctor_id AS wl_doctor,
       patient_id AS wl_patient,
       slot_start_at::text AS wl_slot
FROM waiting_list
WHERE status = 'WAITING'
ORDER BY created_at
LIMIT 1 \gset

\echo '=========================== measurement context =========================='
\echo 'busy_doctor        =' :'busy_doctor'
\echo 'busy_patient       =' :'busy_patient'
\echo 'sample_appointment =' :'sample_appointment'
\echo 'busy_month         =' :'busy_month'
\echo 'month_start        =' :'month_start'
\echo 'month_end          =' :'month_end'
\echo 'availability from  =' :'win_from'
\echo 'availability to    =' :'win_to'
\echo 'wl_doctor          =' :'wl_doctor'
\echo 'wl_patient         =' :'wl_patient'
\echo 'wl_slot            =' :'wl_slot'

SELECT count(*) AS appointments,
       count(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
       count(DISTINCT doctor_id) AS doctors
FROM appointments;

SELECT count(*) AS appointments_for_busy_doctor
FROM appointments
WHERE doctor_id = :'busy_doctor';
```

- [ ] **Step 3: Write the availability measurement**

Create `scripts/perf/01-availability.sql`:

```sql
\echo ''
\echo '=========================================================================='
\echo 'Q1  Availability: confirmed appointments for one doctor over 30 days'
\echo 'Index under test: appointments_no_overlap (GiST, partial on CONFIRMED)'
\echo '=========================================================================='

\echo ''
\echo '--- (a) no appointments index at all -------------------------------------'
BEGIN;
ALTER TABLE appointments DROP CONSTRAINT appointments_no_overlap;
DROP INDEX appointments_doctor_start_at_idx;
EXPLAIN (ANALYZE, BUFFERS)
SELECT start_at, end_at
FROM appointments
WHERE doctor_id = :'busy_doctor'
  AND status = 'CONFIRMED'
  AND tstzrange(start_at, end_at, '[)')
      && tstzrange(:'win_from'::timestamptz, :'win_to'::timestamptz, '[)')
ORDER BY start_at;
ROLLBACK;

\echo ''
\echo '--- (b) GiST gone, btree (doctor_id, start_at) still present -------------'
BEGIN;
ALTER TABLE appointments DROP CONSTRAINT appointments_no_overlap;
EXPLAIN (ANALYZE, BUFFERS)
SELECT start_at, end_at
FROM appointments
WHERE doctor_id = :'busy_doctor'
  AND status = 'CONFIRMED'
  AND tstzrange(start_at, end_at, '[)')
      && tstzrange(:'win_from'::timestamptz, :'win_to'::timestamptz, '[)')
ORDER BY start_at;
ROLLBACK;

\echo ''
\echo '--- (c) with the GiST index ----------------------------------------------'
EXPLAIN (ANALYZE, BUFFERS)
SELECT start_at, end_at
FROM appointments
WHERE doctor_id = :'busy_doctor'
  AND status = 'CONFIRMED'
  AND tstzrange(start_at, end_at, '[)')
      && tstzrange(:'win_from'::timestamptz, :'win_to'::timestamptz, '[)')
ORDER BY start_at;
```

`BEGIN; DROP ...; EXPLAIN ANALYZE ...; ROLLBACK;` is the whole method. DDL is
transactional in PostgreSQL, so the index is genuinely absent for the
measurement and genuinely back afterwards — there is no window in which someone
can interrupt the script and leave the schema missing the constraint the whole
project depends on. It is also the only way to measure without
`appointments_no_overlap`, since dropping that index means dropping the
constraint.

Variant (b) exists because the interesting question is not "index versus no
index" but "which index". If (b) is close to (c), the GiST index is not earning
its keep for availability and the honest thing is to say so in the README.

- [ ] **Step 4: Write the patient-appointments measurement**

Create `scripts/perf/02-patient-appointments.sql`:

```sql
\echo ''
\echo '=========================================================================='
\echo 'Q2  "List my appointments" and the cancel ownership check'
\echo 'Index under test: appointments_patient_start_at_idx'
\echo '=========================================================================='

\echo ''
\echo '--- (a) no patient index at all ------------------------------------------'
BEGIN;
DROP INDEX appointments_patient_start_at_idx;
ALTER TABLE appointments DROP CONSTRAINT appointments_patient_no_overlap;
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, doctor_id, start_at, end_at, status
FROM appointments
WHERE patient_id = :'busy_patient'
ORDER BY start_at DESC
LIMIT 50;
ROLLBACK;

\echo ''
\echo '--- (b) btree gone, only the patient GiST constraint index remains -------'
BEGIN;
DROP INDEX appointments_patient_start_at_idx;
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, doctor_id, start_at, end_at, status
FROM appointments
WHERE patient_id = :'busy_patient'
ORDER BY start_at DESC
LIMIT 50;
ROLLBACK;

\echo ''
\echo '--- (c) with the btree index ---------------------------------------------'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, doctor_id, start_at, end_at, status
FROM appointments
WHERE patient_id = :'busy_patient'
ORDER BY start_at DESC
LIMIT 50;
```

Variant (b) asks a question worth asking: `appointments_patient_no_overlap`
already indexes `patient_id`, so is the btree redundant? A GiST index cannot
serve `ORDER BY start_at DESC` and does not cover cancelled rows, so it should
not be — but "should not be" is a prediction, and this script turns it into a
measurement. Record whichever answer comes back.

- [ ] **Step 5: Write the analytics measurement**

Create `scripts/perf/03-analytics-month.sql`:

```sql
\echo ''
\echo '=========================================================================='
\echo 'Q3  Monthly analytics aggregate for one doctor'
\echo 'Index under test: appointments_doctor_start_at_idx (all statuses)'
\echo '=========================================================================='

\echo ''
\echo '--- (a) without the index ------------------------------------------------'
BEGIN;
DROP INDEX appointments_doctor_start_at_idx;
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) AS total,
       count(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
       COALESCE(
         SUM(EXTRACT(EPOCH FROM (end_at - start_at)) / 60)
           FILTER (WHERE status = 'CONFIRMED'),
         0
       ) AS booked_minutes
FROM appointments
WHERE doctor_id = :'busy_doctor'
  AND start_at >= :'month_start'::timestamptz
  AND start_at <  :'month_end'::timestamptz;
ROLLBACK;

\echo ''
\echo '--- (b) with the index ---------------------------------------------------'
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) AS total,
       count(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
       COALESCE(
         SUM(EXTRACT(EPOCH FROM (end_at - start_at)) / 60)
           FILTER (WHERE status = 'CONFIRMED'),
         0
       ) AS booked_minutes
FROM appointments
WHERE doctor_id = :'busy_doctor'
  AND start_at >= :'month_start'::timestamptz
  AND start_at <  :'month_end'::timestamptz;
```

This is the query that cannot use the partial GiST index, because it must count
CANCELLED rows too. That is the entire justification for keeping a second,
non-partial index on `(doctor_id, start_at)`, and this is where it gets proved
rather than asserted.

- [ ] **Step 6: Write the blocks measurement**

Create `scripts/perf/04-blocks.sql`:

```sql
\echo ''
\echo '=========================================================================='
\echo 'Q4  Blocked periods overlapping an availability window'
\echo 'Index under test: blocks_doctor_time_idx'
\echo 'NOTE: blocks is a small table. A sequential scan winning here is the'
\echo '      planner being correct, not the index being wrong. Record what'
\echo '      actually happens.'
\echo 'NOTE: blocks_no_overlap leaves a GiST index on (doctor_id, tstzrange).'
\echo '      The (a) block drops only the btree, so (a) may still show an index'
\echo '      scan on the constraint index for the doctor_id equality. That is'
\echo '      a real result, not a broken measurement.'
\echo '=========================================================================='

SELECT count(*) AS total_blocks, pg_size_pretty(pg_total_relation_size('blocks')) AS size
FROM blocks;

\echo ''
\echo '--- (a) without the index ------------------------------------------------'
BEGIN;
DROP INDEX blocks_doctor_time_idx;
EXPLAIN (ANALYZE, BUFFERS)
SELECT start_at, end_at, reason
FROM blocks
WHERE doctor_id = :'busy_doctor'
  AND start_at < :'win_to'::timestamptz
  AND end_at   > :'win_from'::timestamptz;
ROLLBACK;

\echo ''
\echo '--- (b) with the index ---------------------------------------------------'
EXPLAIN (ANALYZE, BUFFERS)
SELECT start_at, end_at, reason
FROM blocks
WHERE doctor_id = :'busy_doctor'
  AND start_at < :'win_to'::timestamptz
  AND end_at   > :'win_from'::timestamptz;
```

- [ ] **Step 7: Write the waiting-list measurements**

Create `scripts/perf/05-waiting-list.sql`:

```sql
\echo ''
\echo '=========================================================================='
\echo 'Q5  Assignment job: waiting entries for a freed slot, FIFO'
\echo 'Index under test: waiting_list_doctor_slot_status_idx'
\echo '=========================================================================='

\echo ''
\echo '--- (a) without the index ------------------------------------------------'
BEGIN;
DROP INDEX waiting_list_doctor_slot_status_idx;
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, patient_id, created_at
FROM waiting_list
WHERE doctor_id = :'wl_doctor'
  AND slot_start_at = :'wl_slot'::timestamptz
  AND status = 'WAITING'
ORDER BY created_at
LIMIT 10;
ROLLBACK;

\echo ''
\echo '--- (b) with the index ---------------------------------------------------'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, patient_id, created_at
FROM waiting_list
WHERE doctor_id = :'wl_doctor'
  AND slot_start_at = :'wl_slot'::timestamptz
  AND status = 'WAITING'
ORDER BY created_at
LIMIT 10;

\echo ''
\echo '=========================================================================='
\echo 'Q6  "Am I already in this queue?"'
\echo 'Index under test: waiting_list_one_active (unique, partial on WAITING)'
\echo '=========================================================================='

\echo ''
\echo '--- (a) without the index ------------------------------------------------'
BEGIN;
DROP INDEX waiting_list_one_active;
DROP INDEX waiting_list_doctor_slot_status_idx;
EXPLAIN (ANALYZE, BUFFERS)
SELECT id
FROM waiting_list
WHERE doctor_id = :'wl_doctor'
  AND patient_id = :'wl_patient'
  AND slot_start_at = :'wl_slot'::timestamptz
  AND status = 'WAITING';
ROLLBACK;

\echo ''
\echo '--- (b) with the index ---------------------------------------------------'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id
FROM waiting_list
WHERE doctor_id = :'wl_doctor'
  AND patient_id = :'wl_patient'
  AND slot_start_at = :'wl_slot'::timestamptz
  AND status = 'WAITING';
```

Q6's (a) drops both waiting-list indexes, because leaving the Q5 index in place
would measure that index rather than the absence of this one.

- [ ] **Step 8: Write the notification measurements**

Create `scripts/perf/06-notifications.sql`:

```sql
\echo ''
\echo '=========================================================================='
\echo 'Q7  Job idempotency: have we already handled this appointment?'
\echo 'Index under test: notifications_unique_per_type'
\echo '=========================================================================='

\echo ''
\echo '--- (a) without the index ------------------------------------------------'
BEGIN;
ALTER TABLE notifications DROP CONSTRAINT notifications_unique_per_type;
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, sent_at
FROM notifications
WHERE appointment_id = :'sample_appointment'
  AND type = 'REMINDER';
ROLLBACK;

\echo ''
\echo '--- (b) with the index ---------------------------------------------------'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, sent_at
FROM notifications
WHERE appointment_id = :'sample_appointment'
  AND type = 'REMINDER';

\echo ''
\echo '=========================================================================='
\echo 'Q8  Reconciliation sweeper: due but unsent notifications'
\echo 'Index under test: notifications_pending_due_idx (partial on PENDING)'
\echo '=========================================================================='

SELECT status, count(*) FROM notifications GROUP BY status ORDER BY 2 DESC;

\echo ''
\echo '--- (a) without the index ------------------------------------------------'
BEGIN;
DROP INDEX notifications_pending_due_idx;
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, appointment_id, scheduled_at
FROM notifications
WHERE status = 'PENDING'
  AND scheduled_at <= now()
ORDER BY scheduled_at
LIMIT 100;
ROLLBACK;

\echo ''
\echo '--- (b) with the index ---------------------------------------------------'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, appointment_id, scheduled_at
FROM notifications
WHERE status = 'PENDING'
  AND scheduled_at <= now()
ORDER BY scheduled_at
LIMIT 100;
```

Q8 is the clearest case in the set. With the partial index the plan walks
`scheduled_at` in order and stops after 100 rows; without it, PostgreSQL has to
read every notification row and sort the survivors before it can know which 100
come first.

- [ ] **Step 9: Write the driver**

Create `scripts/perf/explain-evidence.sql`:

```sql
-- Full performance evidence run.
--
--   docker compose exec -T postgres psql -U clinic -d clinic -f /perf/explain-evidence.sql
--
-- Run it twice and keep the second transcript. The first run is measuring how
-- long it takes PostgreSQL to pull pages off disk into shared_buffers, which is
-- a property of the laptop rather than of the index.

\timing off
\pset pager off

\i /perf/00-context.sql
\i /perf/01-availability.sql
\i /perf/02-patient-appointments.sql
\i /perf/03-analytics-month.sql
\i /perf/04-blocks.sql
\i /perf/05-waiting-list.sql
\i /perf/06-notifications.sql

\echo ''
\echo '=========================== end of evidence =============================='
```

- [ ] **Step 10: Smoke-test the harness**

```bash
docker compose exec -T postgres psql -U clinic -d clinic -f /perf/explain-evidence.sql
```

Expected: the context block prints eleven variables and the row counts; then
eighteen plans appear under their headings; no `ERROR:` lines anywhere. If a
`DROP INDEX` errors with "does not exist", go back to Step 1 and fix the name.

Verify nothing was left dropped:

```bash
docker compose exec postgres psql -U clinic -d clinic -c "SELECT conname FROM pg_constraint WHERE conname IN ('appointments_no_overlap','appointments_patient_no_overlap','notifications_unique_per_type') ORDER BY 1;"
```

Expected: all three rows present. This is the check that proves the
rolled-back-transaction method left nothing behind.

- [ ] **Step 11: Commit**

```bash
git add scripts/perf
git commit -m "chore(perf): add EXPLAIN ANALYZE evidence scripts for every index"
```

---

## Task 8: Capture and interpret the evidence

**Files:**
- Create: `docs/performance/raw-<YYYY-MM-DD>.txt`
- Create: `docs/PERFORMANCE.md`

**Interfaces:**
- Consumes: the harness from Task 7 against the full seeded dataset from
  Task 6.
- Produces: `docs/PERFORMANCE.md` containing a filled-in summary table and the
  eight annotated plans. Task 10 copies the summary table into the README.

- [ ] **Step 1: Capture the transcript**

PowerShell:

```powershell
New-Item -ItemType Directory -Force -Path docs/performance | Out-Null
docker compose exec -T postgres psql -U clinic -d clinic -f /perf/explain-evidence.sql | Out-Null
docker compose exec -T postgres psql -U clinic -d clinic -f /perf/explain-evidence.sql |
  Out-File -Encoding utf8 "docs/performance/raw-$(Get-Date -Format yyyy-MM-dd).txt"
```

bash:

```bash
mkdir -p docs/performance
docker compose exec -T postgres psql -U clinic -d clinic -f /perf/explain-evidence.sql > /dev/null
docker compose exec -T postgres psql -U clinic -d clinic -f /perf/explain-evidence.sql \
  | tee "docs/performance/raw-$(date +%F).txt"
```

The first, discarded run warms `shared_buffers`. Keep the second.

- [ ] **Step 2: Learn to read the output before writing anything down**

Four things in each plan, in order of how much they tell you:

**The top node.** `Seq Scan on appointments` means PostgreSQL read all ~2
million rows. `Index Scan using ...`, `Bitmap Heap Scan` or `Index Only Scan`
means it went straight to the rows it wanted. This is the qualitative
difference; everything else is detail.

**`Rows Removed by Filter`.** On a sequential scan this is the waste. A line
reading `rows=24000 ... Rows Removed by Filter: 2005000` says the query threw
away 98.8% of everything it read. With the index that number drops to zero or
near it, because the filtering happened in the `Index Cond` instead.

**`actual time=... rows=... loops=...`.** `actual time` is `startup..total` in
milliseconds *per loop*. Multiply by `loops` for nested nodes. The number to
quote is the `Execution Time` at the bottom, not `Planning Time` — planning is
sub-millisecond and identical either way, and quoting it inflates the "before"
figure for no reason.

**`Buffers: shared hit=N read=M`.** `hit` came from cache, `read` came from the
operating system. A "before" plan with a large `read` and an "after" plan with a
small `hit` is the honest shape. If the "before" plan shows `read=0` you are
comparing two warm caches, which understates the real-world gap rather than
overstating it — note it and move on.

What none of this shows is the index's cost on writes. `docs/DATABASE.md` is
explicit that `appointments` is the write-heavy table and that the index list is
short for that reason. Say so in the README rather than pretending measurement
covered it.

- [ ] **Step 3: Create `docs/PERFORMANCE.md` with the summary table**

Create `docs/PERFORMANCE.md`. Fill every cell from the transcript captured in
Step 1 — do not estimate, and do not carry a number over from another machine:

```markdown
# Index Performance Evidence

Measured against the seeded dataset: 200 doctors, ~2.03 million appointments,
~2.09 million notifications, 60,000 waiting-list entries, spread over 24 months
with a skewed distribution (`docs/TESTING.md`).

Every query is measured against the **busiest** doctor, not an average one.
The context block at the top of `docs/performance/raw-<date>.txt` records which
doctor, patient, month and slot were used.

**Method.** Each "without index" plan is produced by dropping the index inside a
transaction and rolling that transaction back, so the index is genuinely absent
for the measurement and genuinely present afterwards. `SET jit = off` is applied
throughout, because JIT compilation adds variance to large sequential scans and
none to index lookups. The whole script is run twice and the second transcript
is kept, so both sides are measured warm.

**Environment.** MEASURED — record CPU, RAM, Docker Desktop resource limits,
host OS and PostgreSQL version (`SELECT version();`).

| # | Index | Named query | Scan without | Rows removed by filter | Exec ms without | Scan with | Exec ms with | Speed-up |
|---|---|---|---|---|---|---|---|---|
| Q1 | `appointments_no_overlap` | taken slots, one doctor, 30 days | MEASURED | MEASURED | MEASURED | MEASURED | MEASURED | MEASURED |
| Q1b | (btree fallback) | same query, GiST dropped, btree kept | MEASURED | MEASURED | MEASURED | — | — | — |
| Q2 | `appointments_patient_start_at_idx` | list my appointments | MEASURED | MEASURED | MEASURED | MEASURED | MEASURED | MEASURED |
| Q2b | (GiST fallback) | same query, btree dropped | MEASURED | MEASURED | MEASURED | — | — | — |
| Q3 | `appointments_doctor_start_at_idx` | monthly analytics aggregate | MEASURED | MEASURED | MEASURED | MEASURED | MEASURED | MEASURED |
| Q4 | `blocks_doctor_time_idx` | blocks overlapping a window | MEASURED | MEASURED | MEASURED | MEASURED | MEASURED | MEASURED |
| Q5 | `waiting_list_doctor_slot_status_idx` | FIFO candidates for a freed slot | MEASURED | MEASURED | MEASURED | MEASURED | MEASURED | MEASURED |
| Q6 | `waiting_list_one_active` | already in this queue? | MEASURED | MEASURED | MEASURED | MEASURED | MEASURED | MEASURED |
| Q7 | `notifications_unique_per_type` | job idempotency lookup | MEASURED | MEASURED | MEASURED | MEASURED | MEASURED | MEASURED |
| Q8 | `notifications_pending_due_idx` | due but unsent notifications | MEASURED | MEASURED | MEASURED | MEASURED | MEASURED | MEASURED |

## Q1 — availability

**Without any appointments index**

```text
MEASURED — paste the plan from the (a) block
```

**With the GiST exclusion index**

```text
MEASURED — paste the plan from the (c) block
```

MEASURED — two or three sentences on what changed and why.

## Q2 — list my appointments

... one section per query, same shape ...

## Findings

MEASURED — the conclusions the numbers actually support, including any index
that did **not** earn its place. `docs/DATABASE.md` says an index without a
measured query does not belong in the schema; if a measurement says an index is
redundant, either remove it in a follow-up migration or record why it stays.

## What this does not measure

Write cost. Every index on `appointments` is paid for on insert, and
`appointments` is the write-heavy table. The index list is deliberately short
for that reason (`docs/DATABASE.md`), but no benchmark here quantifies it.
```

- [ ] **Step 4: Decide what to do about any index that did not win**

Two outcomes are legitimate and both must be recorded honestly:

- **`blocks_doctor_time_idx` shows no benefit.** Very likely: the table holds
  about 4,000 rows and fits in a handful of pages, so a sequential scan is
  correct. Keep the index and say plainly that it does not pay for itself at
  seed scale but will as blocks accumulate, and that `blocks` is written rarely
  enough for the write cost to be irrelevant. Do not quietly omit the row.
  If the (a) plan uses `blocks_no_overlap` instead of a sequential scan, say so:
  the constraint index covers `doctor_id` equality, which is a further reason the
  btree may not earn its place. `blocks_no_overlap` stays regardless — it is the
  invariant, not an optimisation.
- **`appointments_patient_start_at_idx` is matched by the GiST constraint
  index in Q2b.** If that happens, the btree really is redundant and the
  correct response is a follow-up migration dropping it — that is exactly the
  rule in `docs/DATABASE.md` being applied to your own work.

- [ ] **Step 5: Verify no token survived**

```bash
grep -n "MEASURED" docs/PERFORMANCE.md
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add docs/PERFORMANCE.md docs/performance
git commit -m "docs: record index performance evidence from the seeded dataset"
```

---

## Task 9: The README — sections that can be written from the decision log

Part C. This task writes everything that follows from `docs/DECISIONS.md` and
the feature docs. Task 10 adds what only measurement and the developer can
supply.

**Files:**
- Modify: `README.md` (replace the Nest scaffold content entirely)

**Interfaces:**
- Consumes: `docs/DECISIONS.md`, `docs/API.md`,
  `docs/INFRASTRUCTURE/Concurrency.md`, `docs/INFRASTRUCTURE/Deployment.md`,
  `docs/INFRASTRUCTURE/BackgroundJobs.md`, `docs/FEATURES/WaitingList.md`,
  `docs/FEATURES/Analytics.md`, `docs/DATABASE.md`.
- Produces: a README containing every section the task brief asks for, with
  `MEASURED` tokens standing in for the numbers Task 10 fills.

- [ ] **Step 1: Write the section skeleton**

Replace `README.md` with the following outline, then fill it section by section
in the steps below.

```markdown
# Clinic Appointment Booking

1. What this is
2. Quick start
3. Configuration
4. Seeding a realistic dataset
5. API surface
6. How double booking is prevented
7. Database design and indexes
8. Waiting list: model and assumptions
9. Background jobs and durability
10. Analytics definitions
11. Testing
12. Performance evidence
13. Known limitations and what I would do next
14. How AI was used
15. Screen recording
```

- [ ] **Step 2: Write sections 1 to 5**

```markdown
# Clinic Appointment Booking

A NestJS + PostgreSQL appointment booking API for a clinic: doctors with weekly
schedules and blocked periods, patients booking against a generated slot grid,
a FIFO waiting list that fills cancelled slots automatically, appointment
reminders, and per-doctor monthly analytics computed in SQL.

The interesting part is not the CRUD. It is that several API instances run
behind a load balancer and none of them may double-book a slot, which is a
database problem rather than an application one. Section 6 is the short answer.

## Quick start

Requires Docker and Docker Compose. Nothing else — Node is only needed if you
want to run the test suites on the host.

```bash
git clone <repository-url>
cd clinic_appointment_booking
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
docker compose up --build
```

That starts six services: `postgres`, `redis`, a one-shot `migrate` job, two
`api` replicas, one `worker`, and `nginx` in front of the API replicas.

The API is published on **`http://localhost:8080`**, through nginx. The `api`
containers deliberately do not publish a host port — there are two of them, and
a fixed port mapping would only reach one.

```bash
curl http://localhost:8080/health
# {"status":"ok","database":"up"}
```

`migrate` runs the TypeORM migrations and exits 0 before `api` or `worker`
start. `synchronize: true` is off everywhere, including in tests. If a
migration fails, the stack stops with that as the visible cause instead of
leaving replicas crash-looping against a schema that does not match the code.

To stop and wipe the data volumes:

```bash
docker compose down -v
```

## Configuration

Everything comes from environment variables; `.env.example` lists all of them
and is the file to copy.

| Variable | Example | Notes |
|---|---|---|
| `NODE_ENV` | `development` | |
| `PORT` | `3000` | Port inside the `api` container. nginx publishes 8080. |
| `DATABASE_URL` | `postgres://clinic:clinic@postgres:5432/clinic` | |
| `TEST_DATABASE_URL` | `postgres://clinic:clinic@localhost:5433/clinic_test` | Used only by the integration suite. |
| `REDIS_URL` | `redis://redis:6379` | |
| `JWT_SECRET` | 32+ characters | Validated at startup; a short secret fails the boot. |
| `JWT_EXPIRES_IN` | `1d` | |
| `CLINIC_TZ` | `Africa/Cairo` | **Business configuration, not deployment detail.** |
| `API_REPLICAS` | `2` | |

`CLINIC_TZ` deserves the emphasis. It changes what the API computes, not just
how it runs: a schedule row saying "Sunday 10:00" is a different UTC instant in
January than in July. It is validated at startup against the IANA database, so
a typo fails the boot with a message naming the variable rather than producing
plausible-looking slots that are an hour out for half the year.

## Seeding a realistic dataset

```bash
docker compose --profile seed up seed
```

This loads roughly 200 doctors, 120,000 patients and just over 2 million
appointments spread across 24 months. It is behind a profile because it takes
minutes, and `docker compose up` should not.

The distribution is deliberately **skewed rather than uniform**. A small number
of popular doctors hold several times the median doctor's appointments, about
15% of appointments are cancelled, and recent months are denser than old ones.
Uniform rows per doctor would have been easier to generate and would also have
been the easiest possible case for every index — each doctor's rows a small,
evenly sized slice. The skew produces the worst case, and the busiest doctor's
query plan is the one worth reporting. Section 12 reports it.

Rows are loaded with `COPY ... FROM STDIN` in 50,000-row transactions, with
every constraint left enabled. Loading two million rows one `save()` at a time
through TypeORM would take hours; `COPY` takes minutes. Leaving the exclusion
constraints on costs some of that saving and buys something worth more: the
load is itself a test that the generator never produces two overlapping
appointments for the same doctor or the same patient.

The seed is deterministic — one fixed PRNG seed produces one fixed dataset — so
the performance numbers in section 12 can be reproduced rather than taken on
trust.

Every seeded account uses the password `Password123!`, and the admin is
`admin@clinic.test`. For a faster dataset while developing:

```bash
npm run seed:small
```

## API surface

Full contracts, request and response bodies in [`docs/API.md`](docs/API.md).

```text
POST   /auth/register                             public, always creates a PATIENT
POST   /auth/login                                public
GET    /auth/me                                   any authenticated

POST   /doctors                                   ADMIN
GET    /doctors                                   any authenticated
GET    /doctors/:id                               any authenticated

GET    /doctors/:doctorId/schedules               any authenticated
POST   /doctors/:doctorId/schedules               ADMIN or owning doctor
PATCH  /doctors/:doctorId/schedules/:id           ADMIN or owning doctor
DELETE /doctors/:doctorId/schedules/:id           ADMIN or owning doctor

GET    /doctors/:doctorId/blocks                  any authenticated
POST   /doctors/:doctorId/blocks                  ADMIN or owning doctor
DELETE /doctors/:doctorId/blocks/:id              ADMIN or owning doctor

GET    /doctors/:doctorId/availability?from&to    any authenticated
GET    /doctors/:doctorId/analytics?year&month    ADMIN or owning doctor
GET    /doctors/:doctorId/appointments            ADMIN or owning doctor

POST   /appointments                              PATIENT
GET    /appointments/me                           PATIENT
POST   /appointments/:id/cancel                   PATIENT (owner) or ADMIN

POST   /waiting-list                              PATIENT
GET    /waiting-list/me                           PATIENT
DELETE /waiting-list/:id                          PATIENT (owner)

GET    /health                                    public
```

Three choices in there carry weight:

**`endAt` is never accepted from the client.** The booking body is
`{ doctorId, startAt }`; the server derives the end from the matching schedule
row's slot duration, and the patient from the JWT. A client able to supply
`endAt` could craft a five-minute appointment inside a thirty-minute slot. The
exclusion constraint would still prevent overlap, so nothing would fail loudly —
but the slot grid would rot and availability listings would drift away from
reality.

**Cancel is `POST /appointments/:id/cancel`, not `DELETE`.** The row is kept as
CANCELLED for analytics, so a `DELETE` verb would advertise the opposite of what
happens. Leaving the waiting list *is* a real removal, so that one is a
`DELETE`.

**Errors carry a machine-readable `code`.** Several distinct conditions share
`409` — slot taken, already queued, cancellation window passed. Tests and the
concurrency script assert on `code`, never on message text.

```json
{
  "statusCode": 409,
  "code": "SLOT_ALREADY_BOOKED",
  "message": "This slot has just been booked by another patient.",
  "waitingListAvailable": true
}
```
```

- [ ] **Step 3: Write section 6, the concurrency approach**

```markdown
## How double booking is prevented

Several API instances can receive booking requests for the same slot at the same
moment. Each can check availability, see the slot free, and insert. So an
application-level check is not the protection — the gap between the `SELECT` and
the `INSERT` is the bug itself.

Two layers handle it.

### Layer 1 — the request is snapped to the doctor's slot grid (application)

`POST /appointments` accepts `{ doctorId, startAt }`. The server finds the
schedule row for that weekday in `CLINIC_TZ`, checks that `startAt` lands
exactly on a boundary generated by that row's `slot_duration_minutes`, and
derives `endAt` itself. Off-grid requests are rejected with `400
SLOT_NOT_ON_GRID`. This is what keeps every row on a predictable grid, which is
what makes availability listing and analytics mean anything.

### Layer 2 — PostgreSQL enforces non-overlap (database)

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE appointments ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (
    doctor_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (status = 'CONFIRMED');
```

Booking does not check and then insert. It inserts, and handles the rejection.
The constraint protects the *table*, so the waiting-list job, the seed script
and a human at a `psql` prompt are all covered without any of them having to
remember to be careful.

Two details in that DDL are load-bearing:

- The range bound is `'[)'` — half-open, start inclusive, end exclusive. With
  inclusive bounds, 10:00–10:30 and 10:30–11:00 would count as overlapping and
  every back-to-back booking in the system would be rejected.
- The constraint is partial on `status = 'CONFIRMED'`. Cancelled rows are kept
  for analytics and must not block rebooking the same slot.

### Alternatives considered

| Approach | Why not |
|---|---|
| Application-level check only | The window between `SELECT` and `INSERT` is the race. Rejected outright. |
| Partial unique index on `(doctor_id, start_at)` | Catches identical start times, not overlap. Slot duration lives on each schedule row and may change without rewriting history, so a 30-minute appointment at 10:00 can coexist with a new 15-minute booking at 10:15 — distinct keys, real overlap. |
| PostgreSQL advisory locks | No extension needed, but protects only the code paths that remember to take the lock, and hash collisions serialise unrelated slots. |
| Pessimistic row locking | There is no row to lock when the slot is empty. |
| Redis distributed lock | Adds a failure mode. If Redis is down you either stop accepting bookings or fall back to the database — which means the database was the real protection all along. |

### There are two exclusion constraints, not one

A patient cannot physically attend two appointments at once, so the same shape
is applied to `patient_id`:

```sql
ALTER TABLE appointments ADD CONSTRAINT appointments_patient_no_overlap
  EXCLUDE USING gist (
    patient_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (status = 'CONFIRMED');
```

Allowing overlapping patient appointments would store data that cannot be true.
Booking on behalf of a family member is better served by that person having
their own account than by leaving an invariant unenforced. The constraint also
supplies the `(patient_id, ...)` index the "am I already busy then?" pre-check
needs.

Both constraints raise SQLSTATE `23P01` and they mean different things, so error
handling branches on the **constraint name**, never on the SQLSTATE alone:

- `appointments_no_overlap` → `409 SLOT_ALREADY_BOOKED`. The doctor's slot is
  gone; no retry helps.
- `appointments_patient_no_overlap` → `409 PATIENT_ALREADY_BOOKED`. The slot is
  still free; this caller is busy elsewhere.

Reporting the first for the second case would be actively misleading. Any other
constraint violation propagates as a `500` — a broad `catch` that turns every
database error into "slot taken" hides real bugs.

The waiting-list assignment job needs the same distinction with a larger
consequence. On the doctor constraint it stops, because the slot is gone. On the
patient constraint it moves to the **next candidate**, because the slot is still
assignable. Since an error aborts a PostgreSQL transaction, each candidate
attempt runs inside a `SAVEPOINT`; without that, the first ineligible candidate
would destroy the whole assignment transaction.

That is the clearest example in this project of a small schema decision — naming
two constraints distinctly — reaching all the way into the control flow of a
background job.

### Proof

```bash
npm run test:concurrency
```

The script fires simultaneous booking requests for one slot at **nginx**, which
round-robins them across the two API replicas, and asserts four things:

```text
Successful bookings: 1
Conflicted bookings (409): 9
Unexpected errors (5xx): 0
Confirmed appointments in DB: 1
```

Two of those assertions are more deliberate than they look. Firing at nginx
rather than at a single process matters because the claim being proved is about
several instances behind a load balancer; a single-process `Promise.all` would
exercise the constraint correctly but would not demonstrate the claim that was
made. And asserting `409` rather than "not 201" matters because a `500` is also
a failed booking — it would mean the constraint fired while the error mapping
did not, which is a real bug a looser assertion hides.
```

- [ ] **Step 4: Write section 7, the index explanations**

```markdown
## Database design and indexes

Schema, constraints and naming conventions: [`docs/DATABASE.md`](docs/DATABASE.md).

Instant columns are `timestamptz` and named `*_at`; wall-clock columns are
`time` and named `*_time`. `schedules` stores wall-clock time and carries no
timezone; `appointments` and `blocks` store absolute instants. Conversion
happens in exactly one place in the code — schedule expansion.

`schedules.day_of_week` uses **0 = Sunday**. That is not a preference. The
analytics capacity query joins schedules to generated dates with
`s.day_of_week = EXTRACT(DOW FROM d.day)`, and PostgreSQL returns 0 for Sunday.
Storing ISO 1 = Monday would shift every schedule by one day while still looking
internally consistent, so the column carries a `CHECK (day_of_week BETWEEN 0 AND 6)`
and a comment saying why.

### Every index exists for a named query

`appointments` is the write-heavy table and every index on it is paid for on
insert, so the list is deliberately short. Each entry below names the query it
serves; section 12 has the measured plans.

| Index | Table | Serves |
|---|---|---|
| `appointments_no_overlap` (GiST, partial on CONFIRMED) | appointments | Enforces the booking invariant **and** answers "which slots are taken for this doctor in this range?" for the availability endpoint. One index, two jobs. |
| `appointments_patient_no_overlap` (GiST, partial on CONFIRMED) | appointments | Enforces the patient invariant and backs the "am I already busy then?" pre-check. |
| `(patient_id, start_at)` | appointments | `GET /appointments/me`, and the ownership check on cancel. |
| `(doctor_id, start_at)` | appointments | The monthly analytics query. It must count CANCELLED rows, so it cannot use the partial index — which is the entire reason this second index exists. |
| `(doctor_id, start_at, end_at)` | blocks | Subtracting blocked periods during slot generation. |
| `blocks_no_overlap` (GiST) | blocks | Enforces one period of unavailability per row. It exists for the invariant, not for a query; the btree above is what the range lookup is measured against. |
| `(doctor_id, slot_start_at, status)` | waiting_list | The assignment job finding waiters for a freed slot, and the sweeper scanning for stranded entries. |
| `(doctor_id, patient_id, slot_start_at) WHERE status = 'WAITING'` (unique) | waiting_list | Enforces one active entry per patient per slot, and doubles as the "already queued?" lookup. |
| `(appointment_id, type)` (unique) | notifications | Enforces one notification of each type per appointment, and doubles as the job idempotency lookup. |
| `(scheduled_at) WHERE status = 'PENDING'` | notifications | The reconciliation sweeper finding due-but-unsent notifications. `status` is constant under the predicate, so it is not in the key. |

Four of those indexes are created by constraints rather than declared
separately. That is the point: the invariant and the index are the same object,
so neither can drift away from the other.

### Constraints that are not indexes

`schedules` has `CHECK` constraints on slot duration (15, 30 or 60), on
`start_time < end_time` and on `day_of_week`; `blocks` and `appointments` have
`CHECK (end_at > start_at)`.

Enum-valued columns are stored as `text` with a `CHECK` rather than as native
PostgreSQL enums. Adding a value to a native enum requires `ALTER TYPE`, which
is awkward inside a migration; a `CHECK` constraint is trivially alterable and
just as strict.

**One documented gap.** PostgreSQL has no built-in range type over `time`, so
preventing two overlapping `schedules` rows on the same weekday cannot use an
exclusion constraint without defining a custom range type. That validation lives
in the service layer instead. It is a deliberate gap, not an oversight, and it
is the one invariant in the schema that an application bug could violate.

The rule against overlapping `blocks` looks like the same problem and is not:
those columns are `timestamptz`, so `blocks_no_overlap` enforces it in the
database. The gap is a limitation of the `time` type, not a preference for
validating in the service layer.
```

- [ ] **Step 5: Write section 8, the waiting-list assumptions**

```markdown
## Waiting list: model and assumptions

When a requested slot is taken, the `409` response carries
`waitingListAvailable: true` and the patient can join a queue. When the
appointment is cancelled, a background job books the earliest eligible waiting
patient **directly** — there is no confirmation step.

The task leaves this design open, so here is exactly what was assumed.

1. Queue order is **FIFO by `created_at`**. The earliest entry wins.
2. There is **no priority tier**. Insurance status, seniority and patient
   history do not affect ordering.
3. A patient may hold at most **one active entry per slot**, enforced by a
   partial unique index rather than by an application check.
4. A patient may join the waiting list for **several different slots**.
5. A patient **cannot** join the list for a slot they already hold a CONFIRMED
   appointment for.
6. A patient **cannot** join the list for a slot that is actually free — they
   are told to book it (`409 SLOT_IS_AVAILABLE`).
7. Entries **expire** when the slot's start time passes, or at an optional
   patient-supplied `expires_at` which must be before the slot start. Expired
   entries are skipped by the assignment job and marked EXPIRED by the sweeper.
8. Assignment is **asynchronous**, via BullMQ. It never happens inside the
   cancellation request.
9. Assignment is **transactional and safe to retry**.
10. An assigned appointment is recorded with `created_from = 'WAITING_LIST'`,
    which makes the whole flow provable in the database rather than only in
    logs.
11. The assigned patient gets their own REMINDER notification, scheduled exactly
    like a directly booked appointment.
12. "Notification" means a `notifications` row plus a log line. **No real email
    or SMS** is sent.
13. Queue **position is derived on read**, counting earlier WAITING entries for
    that slot. A stored position column would need renumbering on every removal.

### How assignment actually runs

The worker receives only the slot identity — `doctor_id` and `slot_start_at` —
and re-derives everything else, so a retry always acts on current state. Inside
one transaction it confirms the slot is genuinely free, selects eligible WAITING
entries with `ORDER BY created_at ... FOR UPDATE SKIP LOCKED` so two workers can
never pick the same patient, walks up to ten candidates skipping anyone already
busy at that time, inserts the appointment, transitions the winning entry
`WAITING -> ASSIGNED` with a conditional update acted on by affected row count,
and writes the notification rows. The delayed reminder job is enqueued after
commit.

If no eligible entry exists the job exits successfully. An empty queue is not an
error, and neither is a direct booking having won the race.

### The alternative considered: offer-with-hold

The freed slot would be reserved for the first waiter for a claim window — say
thirty minutes — and they would have to confirm; on expiry it would pass to the
next person. That is closer to how a real clinic behaves, and it avoids booking
someone into an appointment they never re-consented to.

It was rejected for this task because it introduces a third writer competing for
every slot (the direct booker, the hold claimer, the hold-expiry job), plus a
`PENDING_CLAIM` appointment state the overlap constraint would also have to
cover, plus a re-offer chain. That is roughly double the waiting-list work and
most of the remaining bug surface, for a part of the task explicitly left open.

It is the natural next step, and the change would be localised: a new status on
`waiting_list`, a fourth value in the appointment status check, and one extra
delayed job.
```

- [ ] **Step 6: Write sections 9 and 10**

```markdown
## Background jobs and durability

Reminders and waiting-list assignment run on BullMQ in a separate `worker`
service. PostgreSQL is the store of record; Redis is a scheduler.

They cannot commit together, so three rules do the work:

1. **Jobs are enqueued only after the database transaction commits.** Enqueuing
   inside the transaction lets a worker start before the commit lands, read
   stale state, correctly decide there is nothing to do, and lose the work
   permanently with no trace.
2. **Job payloads carry identifiers, never state.** Workers re-derive every
   decision from the database, so a retry always acts on current data.
3. **A reconciliation sweeper runs every minute** and re-derives pending work
   from the `notifications` and `waiting_list` tables. It closes the crash
   window between commit and enqueue, and doubles as the recovery story for a
   Redis restart.

Idempotency is a unique constraint plus a **conditional** status update acted on
by affected row count. Checking whether something has been done and then doing
it is itself a race between two workers; `UPDATE ... WHERE status = 'PENDING'`
returning zero rows is not.

Both job types share one `notifications` table with a `type` column and
`UNIQUE (appointment_id, type)`, rather than a separate `reminders` table. Both
need the same "have we already done this?" check, so one table means one unique
constraint, one conditional-update pattern and one repository instead of
implementing idempotency twice.

Redis runs with no persistence and no volume. Delayed reminder jobs exist only in
Redis until they fire, so restarting it drops the delayed set — but every
reminder also has a `PENDING` `notifications` row in PostgreSQL, and the sweeper
sends anything whose `scheduled_at` has passed. A restart therefore costs at most
one sweep interval and loses nothing. Making Redis durable was considered and
rejected: it would store a second copy of an intent PostgreSQL already owns,
while changing none of the correctness guarantees. Redis is a scheduler;
PostgreSQL is the store of record.

**A transactional outbox was considered and rejected.** It is strictly stronger:
nothing can ever be lost. It was disproportionate here, because it means
building, testing and explaining a second queueing mechanism to close a window
the sweeper already covers within about a minute.

Workers run as a separate service from the API rather than as in-process
processors. One codebase, two bootstraps. In-process processors would couple two
unrelated capacities: scaling the API to two replicas would silently double the
worker pool, which is the kind of coupling that produces "why did we get two
reminders after we scaled up?" incidents.

## Analytics definitions

`GET /doctors/:doctorId/analytics?year=YYYY&month=M` returns four metrics,
computed in a single raw SQL query built from CTEs. Full derivation in
[`docs/FEATURES/Analytics.md`](docs/FEATURES/Analytics.md).

| Metric | Definition |
|---|---|
| Total appointments | Every appointment whose `start_at` falls in the month, CONFIRMED and CANCELLED alike. |
| Cancellation rate | cancelled / total × 100, guarded with `NULLIF` so an empty month returns 0 rather than raising. |
| Peak booking hours | Grouped by the hour of the appointment's **start time in clinic-local time**. All tied hours are returned. |
| Utilization | booked confirmed minutes / available scheduled minutes × 100, where capacity is the weekly schedule expanded across the month minus blocked time. |

Two ambiguities were resolved deliberately rather than silently.

**"Peak booking hours" could mean the hour the booking was created.** The
appointment hour was chosen, because it answers which hours of the working day
are busiest — the question a clinic actually has — rather than when patients
happen to open the app.

**Utilization is minutes-based, not slot-count-based.** The denominator does not
exist as rows anywhere; capacity is a recurring weekly pattern that has to be
expanded over a concrete month. Summing interval durations per schedule row
produces the same ratio as generating every individual slot, with far less to
reason about and no nested `generate_series`.

Two traps in that query are worth calling out, because both produce
plausible-looking wrong answers rather than errors:

- **Month boundaries are taken in clinic-local time**, not UTC, so appointments
  near midnight land in the right month.
- **Blocks are merged with `range_agg` before subtraction.** Intersecting each
  block with a working window separately would subtract any shared minute twice,
  and utilization could then exceed 100% or go negative. A doctor's blocks cannot
  overlap — `blocks_no_overlap` rejects that — so the merge is not the only
  defence, but it makes the arithmetic correct by construction instead of
  depending on a constraint in another table.
  `range_agg` requires PostgreSQL 14+, which is why compose pins
  16.
```

- [ ] **Step 7: Write section 11, testing**

```markdown
## Testing

```bash
npm test                                          # unit tests
docker compose --profile test up -d postgres-test
npm run test:e2e                                  # integration, real PostgreSQL
npm run test:concurrency                          # the proof, fires at nginx
```

Testing targets business-critical behaviour rather than a coverage number.

All time-dependent rules — the 2-hour cancellation window, the 24-hour reminder
offset, waiting-list expiry — are tested through an injected `Clock` with a
fixed time. No service calls `new Date()`. A test that would be flaky at 23:59
is written wrong.

The slot generator is a pure function and gets the densest unit coverage:
schedule expansion, grid alignment, block subtraction, half-open boundaries and
DST transition dates.

Integration tests run against real PostgreSQL with migrations applied — never
`synchronize: true`, not even in tests, because migration correctness is part of
what is being verified.

The concurrency script does not mock the database. Mocking PostgreSQL there
would mean mocking away the entire thing being proven.
```

- [ ] **Step 8: Write section 13, the limitations**

Section 12 (performance) and section 14 (AI usage) are Task 10's; this step
writes the limitations so section 13 is complete.

```markdown
## Known limitations and what I would do next

Written as things I know are missing, not as things I did not think about.

**One clinic timezone.** `CLINIC_TZ` is global. A multi-site clinic across
timezones would need a zone per doctor or per location. The change is localised:
schedule expansion is the only place a zone is applied, so it becomes a
parameter rather than a constant — but every stored schedule would need a zone
and the analytics query's `AT TIME ZONE` calls would become per-row.

**Overlapping schedule rows are validated in the service layer.** PostgreSQL has
no built-in range type over `time`, so this is the one invariant a bug could
violate. A custom range type over `time` plus an exclusion constraint would
close it.

**No offer-with-hold on the waiting list.** Assignment books the waiting patient
directly, without re-consent. Section 8 explains the trade-off; this is the
first thing I would build next.

**Notifications are rows and log lines.** No email or SMS provider is wired up.
The `notifications` table is shaped so adding one is a worker change, not a
schema change.

**Authentication is minimal by design.** JWT with three roles, bcrypt password
hashes. No refresh token rotation, no password reset, no email verification, no
rate limiting on `/auth/login`. Rate limiting is the one I would consider
mandatory before this saw real traffic.

**Availability is informational.** A slot returned as available may be booked
before the booking request arrives. That is correct behaviour rather than a bug
— the booking endpoint carries its own database-level protection — but a client
must not treat an availability response as a reservation.

**Analytics is per doctor, per month only.** No clinic-wide rollup, no date
range other than a calendar month, no caching. At 2 million rows the query
returns in the time recorded in section 12; at 20 million a materialised
monthly rollup would be the next step.

**The sweeper runs every minute.** Recovery from a lost job is therefore bounded
at about a minute rather than being immediate. A transactional outbox would
remove the window entirely and was rejected as disproportionate for this task.

**Seed data is synthetic.** Names, specialisations and phone numbers are
generated. The distribution is modelled to be realistically skewed, but no real
clinic's booking patterns informed it.
```

- [ ] **Step 9: Check the README renders and every internal link resolves**

```bash
grep -o "](docs/[^)]*)" README.md | sed 's/](//;s/)//' | sort -u | xargs -I{} test -f {} && echo "all doc links resolve"
```

Expected: `all doc links resolve`.

- [ ] **Step 10: Commit**

```bash
git add README.md
git commit -m "docs: add README with setup, concurrency approach and design decisions"
```

---

## Task 10: The two sections nobody else can write

Section 12 needs Task 8's real numbers. Section 14 needs the developer's real
experience. Neither can be ghost-written, and this task is explicit about why.

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: `docs/PERFORMANCE.md` from Task 8.
- Produces: a README with no `MEASURED` tokens left and an AI-usage section
  written in the developer's own words.

- [ ] **Step 1: Add section 12 and fill it from `docs/PERFORMANCE.md`**

Paste the frame below into the README, then copy the summary table from
`docs/PERFORMANCE.md` — the one you filled in Task 8 from a real transcript.
Copy it; do not retype it from memory, and do not adjust a number because it
looks unimpressive.

```markdown
## Performance evidence

Measured against the seeded dataset described in section 4: 200 doctors,
~2.03 million appointments, ~2.09 million notifications, 24 months, skewed
distribution. **Every query is measured against the busiest doctor, not an
average one** — that is the plan that has to stay fast.

Each "without index" plan was produced by dropping the index inside a
transaction and rolling that transaction back, so the index was genuinely absent
for the measurement and genuinely present afterwards. `SET jit = off` throughout.
The script was run twice and the second transcript kept, so both sides are
measured with a warm cache.

Full transcripts and per-query commentary: [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).
Reproduce with:

```bash
docker compose --profile seed up seed
docker compose exec -T postgres psql -U clinic -d clinic -f /perf/explain-evidence.sql
```

**Environment:** MEASURED

MEASURED — paste the summary table from docs/PERFORMANCE.md here.

### The two that matter most

**Availability over a 30-day window.** MEASURED — one paragraph: which scan
node appeared in each plan, how many rows the sequential scan discarded, and the
execution times. This is the query a patient waits on.

**Monthly analytics for the busiest doctor.** MEASURED — same shape. This is the
query that cannot use the partial index, because it has to count cancelled rows,
and therefore the reason a second index on `(doctor_id, start_at)` exists.

### What these numbers do not cover

Write cost. Every index on `appointments` is paid for on insert and
`appointments` is the write-heavy table, which is why the index list is short.
Nothing measured here quantifies that cost.

MEASURED — if any index showed no benefit at this scale, say so here and say
what you decided to do about it. An index that does not earn its place is a
finding worth reporting, not an embarrassment worth hiding.
```

- [ ] **Step 2: Replace every `MEASURED` token in section 12**

```bash
grep -n "MEASURED" README.md
```

Work top to bottom until this returns nothing. Every replacement comes from
`docs/performance/raw-<date>.txt`.

To be unambiguous about what this plan did and did not do: the prose around the
numbers in section 12 was written for you; **the numbers were not, and no
example figure appears anywhere in this plan for you to fall back on.** There
is nothing to copy, which is deliberate. An invented "600 ms → 3 ms" is trivial
to falsify — a reviewer runs the seed and the script, or simply asks how many
buffers the sequential scan read.

- [ ] **Step 3: Add section 14 as a set of questions, and answer them yourself**

This section must be written by the developer, in their own words. The plan
deliberately does not draft it.

Fabricating an AI-usage section is dishonest, and it is also the single easiest
thing to catch in a follow-up call. The interviewer only has to ask "what did
the model get wrong in the slot generator?" or "which suggestion did you throw
away?" — questions with no plausible-sounding generic answer. A short, specific,
slightly unflattering account reads far better than a polished one, and it is
the only version that survives being asked about.

Add this heading to the README and answer each question in two to five sentences
of your own. Delete the questions themselves once answered — they are prompts,
not a template.

```markdown
## How AI was used

<!--
Answer each of these in your own words, then delete this comment block.

1. Which parts of this project did you hand to an AI assistant first, and which
   did you deliberately keep for yourself? Why that split?

2. Give one concrete prompt you wrote and describe what came back. Did you keep
   it as-is, edit it, or throw it away?

3. Name one thing the AI got wrong. What was the symptom, how did you notice it,
   and what did you change? (Timezone handling, the half-open range bound, the
   exclusion constraint syntax, and idempotent job design are all places where a
   confident wrong answer is easy to get.)

4. Where did it save you the most time, and roughly how much? Be concrete —
   "about ninety minutes on the analytics SQL" rather than "a lot".

5. Was there a suggestion you rejected? Which one, and on what grounds?

6. Which decision in this README did you make yourself, without or against AI
   input?

7. How did you verify AI-written code you did not fully understand at the time?
   What would you do if a reviewer asked you to explain that code line by line
   right now?

8. If you had to rebuild this in the same two days with no AI assistance at all,
   what would you have cut?
-->
```

- [ ] **Step 4: Verify no tokens or prompt blocks survive**

```bash
grep -n "MEASURED" README.md
grep -n "Answer each of these in your own words" README.md
```

Expected: no output from either.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: add measured performance evidence and AI-usage section to the README"
```

---

## Task 11: The screen recording

**Files:**
- Modify: `README.md` (section 15)

**Interfaces:**
- Consumes: the running stack, the seeded dataset, the concurrency script.
- Produces: a recording checklist in the README and, once recorded, a link to
  the video.

- [ ] **Step 1: Prepare before pressing record**

```bash
docker compose down -v
docker compose up --build -d
docker compose --profile seed up seed        # or npm run seed:small
```

Use `--scale=small` unless you intend to cut the recording. A fifteen-minute
seed on camera is fifteen minutes of dead air, and the demo flow does not need
two million rows — the performance evidence is a document, not a live
performance.

Have ready before recording: two terminals side by side, a third with `psql`
already connected, an HTTP client with the requests pre-written but *not*
pre-sent, and `docker compose logs -f worker` visible somewhere. Rehearse the
60-second explanation once. Do not read it.

- [ ] **Step 2: Record, in this order**

Target about nine minutes.

**1. Run the project (~60s).** `docker compose up`. Point at `migrate` exiting
0 before anything else starts, and at `docker compose ps` showing two `api`
replicas, one `worker`, `nginx` and both databases healthy. Hit
`http://localhost:8080/health`. Say the one sentence: migrations are a one-shot
service, so `synchronize: true` is never needed.

**2. The booking flow (~2 min).** Register a patient, log in, list a doctor's
availability for a date range, book a slot, show the `201`. Show the row in
`psql`. Then book the same slot as a second patient and show the `409` with
`code: SLOT_ALREADY_BOOKED` and `waitingListAvailable: true`. Point out that the
booking body has no `endAt` in it, and that the server derived it.

**3. The concurrency test (~60s).** `npm run test:concurrency`. Read the four
lines out loud. Say why the assertion is `409` and not "not 201": a `500` would
also be a failed booking, and it would mean the constraint fired while the error
mapping did not.

**4. The waiting list, end to end (~3 min).** This is the segment worth
rehearsing, because it has the most moving parts.
   - Second patient joins the waiting list for the taken slot; show the returned
     queue position.
   - First patient cancels the appointment.
   - Switch to the `worker` logs and let the job run on camera.
   - In `psql`, show the new appointment with `created_from = 'WAITING_LIST'`,
     the waiting-list row now `ASSIGNED`, and the `WAITLIST_ASSIGNED` row in
     `notifications`.
   - Say the sentence that ties it together: the job received only the slot
     identity and re-derived everything else, which is what makes it safe to
     retry.

**5. One design decision (~60s).** See Step 3.

**6. Optional if time allows (~30s).** The analytics endpoint for a seeded
doctor, and the summary table in `docs/PERFORMANCE.md`. Do not run
`EXPLAIN ANALYZE` live; it is a document, and reading a query plan aloud is not
watchable.

- [ ] **Step 3: Explain the two-constraint decision, not the one-constraint one**

Of everything in `docs/DECISIONS.md`, explain **decision 16 and its
consequence**: there are two exclusion constraints, they share SQLSTATE `23P01`,
and so the constraint *name* drives control flow.

Four reasons it is the best sixty seconds available:

- It contains the headline concurrency answer as its premise. You cannot explain
  it without first saying "the database enforces non-overlap with a GiST
  exclusion constraint", so you get the required answer and a second-order
  consequence in the same minute.
- Everyone explains the exclusion constraint. Almost nobody explains what
  happens when two constraints share an error code. The second half is where the
  conversation gets interesting.
- It is provable on screen instantly: one `\d appointments` shows both
  constraints, and the demo has already shown both error codes.
- `docs/DECISIONS.md` already nominates it: "the clearest example in the project
  of a small schema decision reaching into application control flow, and it is
  worth walking through on the call."

A script to rehearse from — roughly 55 seconds spoken, and better paraphrased
than recited:

> The booking invariant is enforced by the database, not the application,
> because the application cannot win a race it does not know it is in. If I show
> you the table — there are two exclusion constraints here, not one.
> `appointments_no_overlap` says a doctor cannot hold two overlapping confirmed
> appointments. `appointments_patient_no_overlap` says the same for a patient.
> Both raise SQLSTATE `23P01`, the same error code, but they mean opposite
> things. The first means the slot is gone and no retry will help. The second
> means the slot is still free and this particular patient is busy elsewhere. So
> the error handler branches on the constraint *name*, not the SQLSTATE: one
> becomes `SLOT_ALREADY_BOOKED`, the other `PATIENT_ALREADY_BOOKED`. The
> waiting-list job needs the same distinction with a bigger consequence — on the
> doctor constraint it stops, on the patient constraint it skips to the next
> person in the queue. And because an error aborts a Postgres transaction, each
> candidate attempt runs inside a `SAVEPOINT`, or the first ineligible patient
> would destroy the whole assignment. That is a naming decision in a migration
> reaching all the way into the control flow of a background job.

If the recording is running long, the safe thirty-second version stops after
"the second means the slot is still free" and skips the waiting-list half.

- [ ] **Step 4: Add section 15 to the README**

```markdown
## Screen recording

<!-- Replace with the link once uploaded. -->
**Walkthrough:** <link>

Covered, in order: starting the stack with `docker compose up`; registering and
booking through the API; a conflicting booking returning `409
SLOT_ALREADY_BOOKED`; the concurrency proof against two replicas behind nginx; a
waiting-list scenario end to end from joining the queue through cancellation to
the automatically assigned appointment with `created_from = 'WAITING_LIST'`; and
an explanation of why there are two exclusion constraints on `appointments` and
why the constraint name — not the SQLSTATE — drives error handling and the
waiting-list job's control flow.

The recording uses the small seed profile (`npm run seed:small`) so the dataset
loads in seconds. The performance numbers in section 12 come from the full seed.
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: add screen recording checklist and walkthrough summary"
```

---

## Definition of Done

- [ ] `npx jest src/database/seeds` passes — 28 unit tests.
- [ ] `npm run seed:small` completes in under 30 seconds against an empty
      database.
- [ ] `docker compose --profile seed up seed` exits 0 and loads between
      2,020,000 and 2,045,000 appointments.
- [ ] The full seed completes without a single SQLSTATE `23P01`. This is the
      real proof that the generator never produces overlapping appointments —
      the constraints were enabled the whole time.
- [ ] Cancelled appointments are between 14.5% and 15.5% of the total, and the
      busiest doctor holds at least five times the quietest doctor's count.
- [ ] Running the seed twice without `--reset` fails with a clear message rather
      than doubling the dataset.
- [ ] `docker compose exec -T postgres psql -U clinic -d clinic -f /perf/explain-evidence.sql`
      produces eighteen plans with no `ERROR:` lines.
- [ ] After the evidence run, `appointments_no_overlap`,
      `appointments_patient_no_overlap` and `notifications_unique_per_type` all
      still exist. The rolled-back-transaction method left nothing behind.
- [ ] `docs/PERFORMANCE.md` exists, and `grep -n "MEASURED" docs/PERFORMANCE.md`
      returns nothing.
- [ ] `grep -n "MEASURED" README.md` returns nothing.
- [ ] `grep -n "Answer each of these in your own words" README.md` returns
      nothing — the AI-usage prompts were answered and removed.
- [ ] The README contains sections for setup, concurrency, indexes,
      waiting-list assumptions, AI usage and limitations. Those are the
      deliverables the task named.
- [ ] Every `](docs/...)` link in the README resolves to a file that exists.
- [ ] The recording exists, is under about ten minutes, and shows all five
      required segments.

The four worth actually running rather than eyeballing are the `23P01` one, the
two `grep` checks and the constraints-still-exist check. Each of them fails
silently otherwise, and each of them fails in a way that damages the submission
specifically — bad data, a fabricated number, an unanswered honesty question, or
a database missing the constraint the whole project is about.

---

## Self-Review

Run against the spec for this plan.

**1. Spec coverage.**

| Requirement | Task |
|---|---|
| Seed in `src/database/seeds/`, ~200 doctors, ~2M appointments | 2, 5, 6 |
| Plus users, patients, schedules, blocks | 4, 6 |
| Skewed distribution, ~24 months, ~15% cancelled | 2, 5 |
| Runnable via the `seed` compose profile and an npm script | 6 |
| Deliberate insert strategy, explained, with expected runtime | 6 step 6 |
| A step that actually measures the runtime | 6 step 6 |
| Must not violate the exclusion constraints; explain how | 3, 5, 6 step 4 |
| `EXPLAIN ANALYZE` before and after, per index in `docs/DATABASE.md` | 7, 8 |
| Measured against a busiest doctor | 7 step 2 |
| Exact `psql` commands | 7, 8 step 1 |
| Markdown table skeleton for results | 8 step 3 |
| What a reader should look for in a plan | 8 step 2 |
| Complete README section structure | 9 step 1 |
| Real prose for setup, concurrency + alternatives, indexes, waiting-list assumptions, limitations | 9 steps 2–8 |
| AI-usage section as 6–8 questions, with the honesty statement | 10 step 3 (8 questions) |
| Performance numbers must come from Part B | 10 steps 1–2 |
| Screen-recording checklist with all five segments | 11 step 2 |
| Which decision makes the best 60 seconds, and why | 11 step 3 |
| Every task ends in a commit in `docs/DEVELOPMENT.md` style | all 11 |

No gaps found.

**2. Placeholder scan.** The only recurring token is `MEASURED`, defined in the
Global Constraints as a marker for values that must come from a real run, with
two `grep` checks in the Definition of Done proving none survive. There are no
`TBD`s, no "add appropriate X", and no "similar to Task N" — the psql scripts
repeat each query verbatim in every variant rather than referring back.

**3. Type consistency.** Checked across tasks:

- `encodeCopyRow` / `encodeCopyValue` / `copyRows` — defined in Task 1, used
  under those names in Tasks 4, 5 and 6.
- `Rng` methods `next`, `int`, `pick`, `chance` — defined in Task 1, and only
  those four are called later.
- `PatientOccupancy.isFree` / `.claim` with `(patientIndex, startAt, endAt)` —
  defined in Task 3, called with that signature in Task 5.
- `ScheduleRow` and `BlockRow` field names — defined in Task 4, mapped into
  `generateSlots`'s `ScheduleWindow` and `TimeRange` shapes in Task 5 exactly as
  `docs/PLANS/00-interfaces.md` declares them.
- `GeneratorContext` — declared in Task 5's Interfaces block, constructed with
  the same field set in Task 6 and in the Task 5 spec's `contextFor` helper.
- Column arrays (`USER_COLUMNS`, `APPOINTMENT_COLUMNS`, …) — every name matches
  the entity column names in `docs/PLANS/00-interfaces.md`.
- Index and constraint names — the nine in Task 7 step 1 are the same nine used
  in the scripts, in `docs/PERFORMANCE.md` and in README section 7, and Task 7
  step 1 reconciles them against `\di+` before anything depends on them.

One fix applied during review: Task 5's `rememberContested` originally pushed
every future confirmed slot, which would have held hundreds of thousands of
objects in memory for no reason. It now samples into a bounded reservoir sized
by `SeedConfig.contestedReservoir`.

---

## Next

This is the last plan. What remains is not code: run the full seed once more on
a quiet machine so the numbers in section 12 are the best available, record the
walkthrough, and answer the eight questions in section 14 honestly.
