# Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running NestJS API backed by PostgreSQL and Redis, with validated
configuration, migration-based schema management, a deterministic clock, a
consistent error contract, and a health endpoint — all startable with
`docker compose up`.

**Architecture:** Feature-based layered modules (controller → service →
repository) per `docs/ARCHITECTURE.md`. This plan builds only the shared
infrastructure every later plan depends on: configuration, database connection,
migrations, the `Clock` provider, the error response shape, and container
orchestration. No business features.

**Tech Stack:** NestJS 11, TypeScript 5.7, TypeORM, PostgreSQL 16, Redis 7,
Luxon, Jest 30, Supertest, Docker Compose.

## Global Constraints

- `synchronize: true` is forbidden in every environment, including tests. All
  schema changes go through migrations. (`docs/STACK.md`)
- PostgreSQL major version **16**. `range_agg` requires 14+; the analytics query
  depends on it. (`docs/INFRASTRUCTURE/Deployment.md`)
- Redis major version **7**, started with `--appendonly yes` and a named volume.
- All configuration comes from environment variables. Nothing hardcoded. A
  committed `.env.example` lists every variable. (`docs/DEVELOPMENT.md`)
- `CLINIC_TZ` defines the single clinic timezone and must be a valid IANA zone.
  (`docs/DECISIONS.md` #3)
- No service reads the current time via `new Date()`. Time comes from the
  injected `Clock`. (`docs/ARCHITECTURE.md`)
- Error bodies are `{ statusCode, code, message }` where `code` is a member of
  `ErrorCode`. (`docs/API.md`)
- Commit messages follow the convention in `docs/DEVELOPMENT.md`, e.g.
  `feat(config): validate environment variables at startup`.
- Node 22 LTS.

---

## File Structure

**Created by this plan:**

```text
docker-compose.yml               postgres + redis (dev), then api + migrate
Dockerfile                       multi-stage build for api/worker/migrate
.env.example                     every required variable, documented
.dockerignore

src/config/
  env.validation.ts              EnvironmentVariables class + validateEnv()
  is-iana-timezone.validator.ts  custom class-validator rule for CLINIC_TZ
  config.module.ts               ConfigModule.forRoot wiring

src/database/
  data-source.ts                 TypeORM CLI DataSource (migrations)
  database.module.ts             TypeOrmModule.forRootAsync wiring
  migrations/
    1756800000000-EnableBtreeGist.ts

src/common/clock/
  clock.ts                       Clock abstract + SystemClock + FixedClock
  clock.module.ts

src/common/errors/
  error-code.enum.ts             the documented code taxonomy
  app.exception.ts               HttpException carrying an ErrorCode

src/common/filters/
  all-exceptions.filter.ts       normalises every error to the contract

src/health/
  health.controller.ts
  health.module.ts

test/
  setup-db.ts                    runs migrations before the e2e suite
  jest-e2e.json                  (modified) globalSetup + setupFiles
```

**Modified:** `package.json` (dependencies, scripts), `src/app.module.ts`,
`src/main.ts`.

**Deleted:** `src/app.controller.ts`, `src/app.controller.spec.ts`,
`src/app.service.ts` — Nest scaffold placeholders replaced by the health module.

Responsibilities are deliberately narrow: `config/` validates input,
`database/` owns the connection and migrations, `common/` holds cross-cutting
primitives with no feature knowledge, `health/` is the only HTTP surface here.

---

## Task 1: Development infrastructure (Postgres + Redis)

Bring up the databases first so every later task can be tested against real
PostgreSQL rather than a mock.

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example`
- Create: `.dockerignore`

**Interfaces:**
- Consumes: nothing.
- Produces: PostgreSQL on `localhost:5432` (db `clinic`, user `clinic`), a test
  database `clinic_test` on `localhost:5433`, Redis on `localhost:6379`. Env var
  names `DATABASE_URL`, `TEST_DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`,
  `JWT_EXPIRES_IN`, `CLINIC_TZ`, `PORT`, `NODE_ENV`.

- [ ] **Step 1: Create `.env.example`**

```bash
# Application
NODE_ENV=development
PORT=3000

# PostgreSQL
DATABASE_URL=postgres://clinic:clinic@localhost:5432/clinic
# Separate database used by the integration/e2e suite
TEST_DATABASE_URL=postgres://clinic:clinic@localhost:5433/clinic_test

# Redis (BullMQ)
REDIS_URL=redis://localhost:6379

# Auth — must be at least 32 characters
JWT_SECRET=change-me-to-a-long-random-string-min-32
JWT_EXPIRES_IN=1d

# Business configuration: the clinic's single timezone (IANA name).
# This changes what the API computes, not just how it runs.
CLINIC_TZ=Africa/Cairo
```

- [ ] **Step 2: Create `.dockerignore`**

```text
node_modules
dist
coverage
.git
.env
*.log
```

- [ ] **Step 3: Create `docker-compose.yml` with the data services only**

App containers are added in Task 7. Until then you run the API on the host
against these services, which is the faster loop on Windows.

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: clinic
      POSTGRES_PASSWORD: clinic
      POSTGRES_DB: clinic
    ports:
      - '5432:5432'
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U clinic -d clinic']
      interval: 5s
      timeout: 5s
      retries: 10

  postgres-test:
    image: postgres:16-alpine
    profiles: ['test']
    environment:
      POSTGRES_USER: clinic
      POSTGRES_PASSWORD: clinic
      POSTGRES_DB: clinic_test
    ports:
      - '5433:5432'
    # No volume: the test database is disposable by design.
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U clinic -d clinic_test']
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    command: ['redis-server', '--appendonly', 'yes']
    ports:
      - '6379:6379'
    volumes:
      - redisdata:/data
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  pgdata:
  redisdata:
```

Redis uses `--appendonly yes` with a named volume because delayed reminder jobs
exist only in Redis until they fire. See
`docs/INFRASTRUCTURE/Deployment.md`.

- [ ] **Step 4: Start the services and verify both are healthy**

```bash
cp .env.example .env
docker compose up -d postgres redis
docker compose --profile test up -d postgres-test
docker compose ps
```

Expected: `postgres`, `postgres-test` and `redis` all show status `healthy`.

- [ ] **Step 5: Verify PostgreSQL is reachable and is version 16**

```bash
docker compose exec postgres psql -U clinic -d clinic -c "SELECT version();"
```

Expected: output contains `PostgreSQL 16`.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml .env.example .dockerignore
git commit -m "chore(infra): add postgres and redis services for local development"
```

---

## Task 2: Validated configuration

Fail at startup on bad configuration rather than at the first request that needs
it.

**Files:**
- Create: `src/config/is-iana-timezone.validator.ts`
- Create: `src/config/env.validation.ts`
- Create: `src/config/config.module.ts`
- Test: `src/config/env.validation.spec.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: env var names from Task 1.
- Produces: `EnvironmentVariables` class (properties `NODE_ENV`, `PORT`,
  `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `CLINIC_TZ`);
  `validateEnv(raw: Record<string, unknown>): EnvironmentVariables`;
  `AppConfigModule`. Later plans read config via Nest's `ConfigService` and
  `getOrThrow<string>('CLINIC_TZ')`.

- [ ] **Step 1: Install dependencies**

```bash
npm install @nestjs/config @nestjs/typeorm typeorm pg class-validator class-transformer luxon dotenv
npm install --save-dev @types/luxon
```

- [ ] **Step 2: Write the failing test**

Create `src/config/env.validation.spec.ts`:

```ts
import { validateEnv } from './env.validation';

const valid = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgres://clinic:clinic@localhost:5432/clinic',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a'.repeat(32),
  JWT_EXPIRES_IN: '1d',
  CLINIC_TZ: 'Africa/Cairo',
};

describe('validateEnv', () => {
  it('accepts a complete, valid environment', () => {
    const result = validateEnv(valid);
    expect(result.CLINIC_TZ).toBe('Africa/Cairo');
  });

  it('coerces PORT to a number', () => {
    expect(validateEnv(valid).PORT).toBe(3000);
  });

  it('rejects a missing DATABASE_URL', () => {
    const { DATABASE_URL, ...withoutDb } = valid;
    expect(() => validateEnv(withoutDb)).toThrow(/DATABASE_URL/);
  });

  it('rejects a JWT_SECRET shorter than 32 characters', () => {
    expect(() => validateEnv({ ...valid, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('rejects a CLINIC_TZ that is not a real IANA zone', () => {
    expect(() => validateEnv({ ...valid, CLINIC_TZ: 'Mars/Olympus' })).toThrow(
      /CLINIC_TZ/,
    );
  });

  it('accepts UTC as a CLINIC_TZ', () => {
    expect(validateEnv({ ...valid, CLINIC_TZ: 'UTC' }).CLINIC_TZ).toBe('UTC');
  });
});
```

The `Mars/Olympus` case is the one that matters. A typo'd timezone would
otherwise be caught only when Luxon silently returned invalid dates during slot
generation, which is very hard to trace back.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest src/config/env.validation.spec.ts`
Expected: FAIL — `Cannot find module './env.validation'`.

- [ ] **Step 4: Write the custom timezone validator**

Create `src/config/is-iana-timezone.validator.ts`:

```ts
import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { IANAZone } from 'luxon';

@ValidatorConstraint({ name: 'isIanaTimeZone', async: false })
export class IsIanaTimeZoneConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && IANAZone.isValidZone(value);
  }

  defaultMessage(): string {
    return 'CLINIC_TZ must be a valid IANA time zone name, for example Africa/Cairo';
  }
}

export function IsIanaTimeZone(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: IsIanaTimeZoneConstraint,
    });
  };
}
```

- [ ] **Step 5: Write the environment schema and validator**

Create `src/config/env.validation.ts`:

```ts
import { plainToInstance } from 'class-transformer';
import { IsEnum, IsInt, IsString, MinLength, validateSync } from 'class-validator';
import { IsIanaTimeZone } from './is-iana-timezone.validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsInt()
  PORT: number = 3000;

  @IsString()
  DATABASE_URL!: string;

  @IsString()
  REDIS_URL!: string;

  @IsString()
  @MinLength(32, { message: 'JWT_SECRET must be at least 32 characters long' })
  JWT_SECRET!: string;

  @IsString()
  JWT_EXPIRES_IN: string = '1d';

  @IsIanaTimeZone()
  CLINIC_TZ!: string;
}

export function validateEnv(raw: Record<string, unknown>): EnvironmentVariables {
  const parsed = plainToInstance(EnvironmentVariables, raw, {
    enableImplicitConversion: true,
    exposeDefaultValues: true,
  });

  const errors = validateSync(parsed, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map((error) => `${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`)
      .join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${details}`);
  }

  return parsed;
}
```

Error messages include the property name, which is why the tests can assert on
`/DATABASE_URL/`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx jest src/config/env.validation.spec.ts`
Expected: PASS — 6 tests.

- [ ] **Step 7: Wire the config module**

Create `src/config/config.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
  ],
})
export class AppConfigModule {}
```

`isGlobal` means later plans inject `ConfigService` without re-importing.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/config
git commit -m "feat(config): validate environment variables at startup"
```

---

## Task 3: Database connection and the first migration

**Files:**
- Create: `src/database/data-source.ts`
- Create: `src/database/database.module.ts`
- Create: `src/database/migrations/1756800000000-EnableBtreeGist.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `DATABASE_URL` (Task 2).
- Produces: `AppDataSource` (default export of `data-source.ts`, used by the
  TypeORM CLI); `DatabaseModule`; npm scripts `migration:run`,
  `migration:revert`, `migration:generate`. Later plans add entities discovered
  via `autoLoadEntities` and migrations to the same folder.

- [ ] **Step 1: Create the CLI data source**

Create `src/database/data-source.ts`:

```ts
import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

loadDotenv();

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/database/migrations/*.ts'],
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
});

export default AppDataSource;
```

The TypeORM CLI needs its own `DataSource` outside the Nest DI container. This
file is that seam, and it is the only place a connection is built from
`process.env` directly.

- [ ] **Step 2: Add the migration scripts to `package.json`**

Add to `"scripts"`:

```json
"typeorm": "typeorm-ts-node-commonjs -d src/database/data-source.ts",
"migration:run": "npm run typeorm -- migration:run",
"migration:revert": "npm run typeorm -- migration:revert",
"migration:generate": "npm run typeorm -- migration:generate"
```

- [ ] **Step 3: Write the `btree_gist` migration**

Create `src/database/migrations/1756800000000-EnableBtreeGist.ts`:

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class EnableBtreeGist1756800000000 implements MigrationInterface {
  name = 'EnableBtreeGist1756800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Required by the appointment overlap exclusion constraints added later.
    // Created here so the extension exists before any table depends on it.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP EXTENSION IF EXISTS btree_gist`);
  }
}
```

- [ ] **Step 4: Run the migration**

```bash
npm run migration:run
```

Expected: output contains `Migration EnableBtreeGist1756800000000 has been executed successfully.`

- [ ] **Step 5: Verify the extension exists**

```bash
docker compose exec postgres psql -U clinic -d clinic -c "SELECT extname FROM pg_extension WHERE extname = 'btree_gist';"
```

Expected: one row, `btree_gist`.

- [ ] **Step 6: Verify the migration is reversible**

```bash
npm run migration:revert
docker compose exec postgres psql -U clinic -d clinic -c "SELECT count(*) FROM pg_extension WHERE extname = 'btree_gist';"
npm run migration:run
```

Expected: count `0` after revert, and the re-run succeeds. A migration that
cannot be reverted is not finished.

- [ ] **Step 7: Wire the Nest database module**

Create `src/database/database.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.getOrThrow<string>('DATABASE_URL'),
        autoLoadEntities: true,
        // Never true, in any environment. Schema changes go through migrations.
        synchronize: false,
        // Migrations are run by the dedicated `migrate` service, not on boot.
        migrationsRun: false,
      }),
    }),
  ],
})
export class DatabaseModule {}
```

- [ ] **Step 8: Commit**

```bash
git add package.json src/database
git commit -m "feat(database): add TypeORM data source, migrations and btree_gist extension"
```

---

## Task 4: The Clock provider

**Files:**
- Create: `src/common/clock/clock.ts`
- Create: `src/common/clock/clock.module.ts`
- Test: `src/common/clock/clock.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: abstract class `Clock` with `now(): Date`; `SystemClock`;
  `FixedClock` (constructor `(fixed: Date)`, method `set(next: Date): void`);
  `ClockModule` exporting the `Clock` token bound to `SystemClock`.

Later plans inject `Clock` and, in tests, override the provider with
`FixedClock`. The 2-hour cancellation rule and the 24-hour reminder offset both
depend on this.

- [ ] **Step 1: Write the failing test**

Create `src/common/clock/clock.spec.ts`:

```ts
import { FixedClock, SystemClock } from './clock';

describe('SystemClock', () => {
  it('returns the current time', () => {
    const before = Date.now();
    const now = new SystemClock().now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
  });
});

describe('FixedClock', () => {
  it('always returns the time it was constructed with', () => {
    const fixed = new Date('2026-09-06T09:00:00.000Z');
    const clock = new FixedClock(fixed);

    expect(clock.now()).toEqual(fixed);
    expect(clock.now()).toEqual(fixed);
  });

  it('can be advanced', () => {
    const clock = new FixedClock(new Date('2026-09-06T09:00:00.000Z'));
    clock.set(new Date('2026-09-06T14:00:00.000Z'));

    expect(clock.now().toISOString()).toBe('2026-09-06T14:00:00.000Z');
  });

  it('returns a copy, so callers cannot mutate the clock', () => {
    const clock = new FixedClock(new Date('2026-09-06T09:00:00.000Z'));
    const first = clock.now();
    first.setFullYear(1999);

    expect(clock.now().getFullYear()).toBe(2026);
  });
});
```

The third test matters more than it looks. `Date` is mutable, so returning the
stored instance would let one caller silently change the clock for everyone.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/common/clock/clock.spec.ts`
Expected: FAIL — `Cannot find module './clock'`.

- [ ] **Step 3: Implement the clock**

Create `src/common/clock/clock.ts`:

```ts
/**
 * Injectable source of the current time.
 *
 * Every time-dependent business rule reads time through this, never through
 * `new Date()`. Without it, the 2-hour cancellation window and the 24-hour
 * reminder offset cannot be tested deterministically.
 */
export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock extends Clock {
  constructor(private fixed: Date) {
    super();
  }

  now(): Date {
    return new Date(this.fixed.getTime());
  }

  set(next: Date): void {
    this.fixed = next;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/common/clock/clock.spec.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Create the module**

Create `src/common/clock/clock.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { Clock, SystemClock } from './clock';

@Global()
@Module({
  providers: [{ provide: Clock, useClass: SystemClock }],
  exports: [Clock],
})
export class ClockModule {}
```

`@Global` because nearly every feature module needs it, and re-importing it
everywhere would be noise.

- [ ] **Step 6: Commit**

```bash
git add src/common/clock
git commit -m "feat(common): add injectable Clock for deterministic time handling"
```

---

## Task 5: The error contract

**Files:**
- Create: `src/common/errors/error-code.enum.ts`
- Create: `src/common/errors/app.exception.ts`
- Create: `src/common/filters/all-exceptions.filter.ts`
- Test: `src/common/filters/all-exceptions.filter.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: enum `ErrorCode` (values as documented in `docs/API.md`);
  `AppException` (constructor `(code: ErrorCode, message: string, status:
  HttpStatus, extra?: Record<string, unknown>)`); helper subclasses
  `ConflictError` and `BadRequestError`; `AllExceptionsFilter`.

Every later plan throws `AppException` subclasses rather than raw Nest
exceptions when a documented `code` applies.

- [ ] **Step 1: Write the error code enum**

Create `src/common/errors/error-code.enum.ts`:

```ts
/**
 * Machine-readable error codes returned alongside the HTTP status.
 *
 * Several distinct conditions share status 409, so tests and the concurrency
 * script assert on these codes rather than on message text.
 * Contract documented in docs/API.md.
 */
export enum ErrorCode {
  SlotAlreadyBooked = 'SLOT_ALREADY_BOOKED',
  PatientAlreadyBooked = 'PATIENT_ALREADY_BOOKED',
  SlotNotOnGrid = 'SLOT_NOT_ON_GRID',
  SlotOutsideSchedule = 'SLOT_OUTSIDE_SCHEDULE',
  SlotBlocked = 'SLOT_BLOCKED',
  CancellationWindowPassed = 'CANCELLATION_WINDOW_PASSED',
  AlreadyInWaitingList = 'ALREADY_IN_WAITING_LIST',
  SlotIsAvailable = 'SLOT_IS_AVAILABLE',
  DateRangeTooLarge = 'DATE_RANGE_TOO_LARGE',
  NotAppointmentOwner = 'NOT_APPOINTMENT_OWNER',
  ValidationFailed = 'VALIDATION_FAILED',
  Unauthorized = 'UNAUTHORIZED',
  Forbidden = 'FORBIDDEN',
  NotFound = 'NOT_FOUND',
  InternalError = 'INTERNAL_ERROR',
}
```

- [ ] **Step 2: Write the exception class**

Create `src/common/errors/app.exception.ts`:

```ts
import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-code.enum';

export class AppException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    status: HttpStatus,
    readonly extra: Record<string, unknown> = {},
  ) {
    super({ code, message, ...extra }, status);
  }
}

export class ConflictError extends AppException {
  constructor(code: ErrorCode, message: string, extra?: Record<string, unknown>) {
    super(code, message, HttpStatus.CONFLICT, extra);
  }
}

export class BadRequestError extends AppException {
  constructor(code: ErrorCode, message: string, extra?: Record<string, unknown>) {
    super(code, message, HttpStatus.BAD_REQUEST, extra);
  }
}
```

`extra` exists so the booking conflict can carry `waitingListAvailable: true`
without a bespoke exception type.

- [ ] **Step 3: Write the failing filter test**

Create `src/common/filters/all-exceptions.filter.spec.ts`:

```ts
import { ArgumentsHost, HttpStatus, NotFoundException } from '@nestjs/common';
import { ErrorCode } from '../errors/error-code.enum';
import { ConflictError } from '../errors/app.exception';
import { AllExceptionsFilter } from './all-exceptions.filter';

function hostWithResponse() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;

  return { host, status, json };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  it('shapes an AppException into statusCode, code and message', () => {
    const { host, status, json } = hostWithResponse();

    filter.catch(
      new ConflictError(ErrorCode.SlotAlreadyBooked, 'Slot taken', {
        waitingListAvailable: true,
      }),
      host,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(json).toHaveBeenCalledWith({
      statusCode: HttpStatus.CONFLICT,
      code: ErrorCode.SlotAlreadyBooked,
      message: 'Slot taken',
      waitingListAvailable: true,
    });
  });

  it('gives a plain Nest exception a sensible default code', () => {
    const { host, status, json } = hostWithResponse();

    filter.catch(new NotFoundException('Doctor not found'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(json).toHaveBeenCalledWith({
      statusCode: HttpStatus.NOT_FOUND,
      code: ErrorCode.NotFound,
      message: 'Doctor not found',
    });
  });

  it('never leaks internals from an unknown error', () => {
    const { host, status, json } = hostWithResponse();

    filter.catch(new Error('connection string: postgres://user:secret@host'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.InternalError,
      message: 'Internal server error',
    });
  });
});
```

The third test is a security assertion, not a formatting one: database errors
routinely contain connection strings and SQL.

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx jest src/common/filters/all-exceptions.filter.spec.ts`
Expected: FAIL — `Cannot find module './all-exceptions.filter'`.

- [ ] **Step 5: Implement the filter**

Create `src/common/filters/all-exceptions.filter.ts`:

```ts
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-code.enum';

const DEFAULT_CODE_BY_STATUS: Partial<Record<HttpStatus, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.ValidationFailed,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.Unauthorized,
  [HttpStatus.FORBIDDEN]: ErrorCode.Forbidden,
  [HttpStatus.NOT_FOUND]: ErrorCode.NotFound,
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof AppException) {
      const status = exception.getStatus();
      response.status(status).json({
        statusCode: status,
        code: exception.code,
        message: exception.message,
        ...exception.extra,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      response.status(status).json({
        statusCode: status,
        code: DEFAULT_CODE_BY_STATUS[status] ?? ErrorCode.InternalError,
        message:
          typeof body === 'string'
            ? body
            : ((body as { message?: string | string[] }).message ?? exception.message),
      });
      return;
    }

    // Unknown failure: log the detail, return nothing revealing.
    this.logger.error('Unhandled exception', exception as Error);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.InternalError,
      message: 'Internal server error',
    });
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx jest src/common/filters/all-exceptions.filter.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 7: Commit**

```bash
git add src/common/errors src/common/filters
git commit -m "feat(common): add error code taxonomy and global exception filter"
```

---

## Task 6: Health endpoint and application bootstrap

**Files:**
- Create: `src/health/health.controller.ts`
- Create: `src/health/health.module.ts`
- Test: `test/health.e2e-spec.ts`
- Create: `test/setup-db.ts`
- Modify: `test/jest-e2e.json`
- Modify: `src/app.module.ts`
- Modify: `src/main.ts`
- Delete: `src/app.controller.ts`, `src/app.controller.spec.ts`, `src/app.service.ts`
- Delete: `test/app.e2e-spec.ts`

**Interfaces:**
- Consumes: `DatabaseModule` (Task 3), `AppConfigModule` (Task 2),
  `ClockModule` (Task 4), `AllExceptionsFilter` (Task 5).
- Produces: `GET /health` returning `200 { status: 'ok', database: 'up' }` or
  `503 { status: 'error', database: 'down' }`; a working e2e harness that runs
  migrations against `TEST_DATABASE_URL` before the suite.

- [ ] **Step 1: Write the failing e2e test**

Create `test/health.e2e-spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

describe('GET /health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports ok when the database is reachable', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body).toEqual({ status: 'ok', database: 'up' });
  });
});
```

- [ ] **Step 2: Create the test database bootstrap**

Create `test/setup-db.ts`:

```ts
import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

loadDotenv();

/**
 * Runs migrations against the test database before the e2e suite.
 *
 * Migrations, not `synchronize: true` — migration correctness is part of what
 * the suite verifies.
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL is required to run the e2e suite');
  }

  process.env.DATABASE_URL = url;

  const dataSource = new DataSource({
    type: 'postgres',
    url,
    migrations: ['src/database/migrations/*.ts'],
    synchronize: false,
  });

  await dataSource.initialize();
  await dataSource.runMigrations();
  await dataSource.destroy();
}
```

Reassigning `DATABASE_URL` is what keeps the suite off the development database.

- [ ] **Step 3: Point the e2e Jest config at the bootstrap**

Replace `test/jest-e2e.json`:

```json
{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": "..",
  "testEnvironment": "node",
  "testRegex": ".e2e-spec.ts$",
  "transform": {
    "^.+\\.(t|j)s$": "ts-jest"
  },
  "globalSetup": "<rootDir>/test/setup-db.ts",
  "maxWorkers": 1
}
```

`maxWorkers: 1` because these tests share one database. Parallel workers would
see each other's rows and fail unpredictably.

- [ ] **Step 4: Run the test to verify it fails**

```bash
docker compose --profile test up -d postgres-test
npm run test:e2e
```

Expected: FAIL — `Cannot GET /health` (404), because the controller does not
exist yet.

- [ ] **Step 5: Implement the health controller**

Create `src/health/health.controller.ts`:

```ts
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Response } from 'express';
import { DataSource } from 'typeorm';

@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  async check(@Res() response: Response): Promise<void> {
    try {
      await this.dataSource.query('SELECT 1');
      response.status(HttpStatus.OK).json({ status: 'ok', database: 'up' });
    } catch {
      // 503 rather than 500: the process is alive but must not receive traffic.
      // nginx and compose both route on this.
      response
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json({ status: 'error', database: 'down' });
    }
  }
}
```

Create `src/health/health.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

@Module({ controllers: [HealthController] })
export class HealthModule {}
```

- [ ] **Step 6: Replace the scaffold app module**

Replace `src/app.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ClockModule } from './common/clock/clock.module';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [AppConfigModule, DatabaseModule, ClockModule, HealthModule],
})
export class AppModule {}
```

Delete the scaffold files:

```bash
git rm src/app.controller.ts src/app.controller.spec.ts src/app.service.ts test/app.e2e-spec.ts
```

- [ ] **Step 7: Wire the bootstrap**

Replace `src/main.ts`:

```ts
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  const port = app.get(ConfigService).getOrThrow<number>('PORT');
  await app.listen(port);
}

void bootstrap();
```

`whitelist` with `forbidNonWhitelisted` is load-bearing, not hygiene: it is what
makes an `endAt` or `role` field sent by a client an error rather than something
silently ignored.

- [ ] **Step 8: Run the e2e test to verify it passes**

Run: `npm run test:e2e`
Expected: PASS — `GET /health reports ok when the database is reachable`.

- [ ] **Step 9: Run the whole unit suite**

Run: `npm test`
Expected: PASS — 13 tests across `env.validation`, `clock` and
`all-exceptions.filter`.

- [ ] **Step 10: Commit**

```bash
git add src test
git commit -m "feat(health): add health endpoint and application bootstrap"
```

---

## Task 7: Containerise the API and run migrations as a one-shot service

**Files:**
- Create: `Dockerfile`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: everything above.
- Produces: `docker compose up` serving the API on `localhost:3000` with
  migrations already applied. Plan 5 adds nginx and a second `api` replica; Plan
  6 adds the `worker` service using the same image with a different command.

- [ ] **Step 1: Create the Dockerfile**

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/main"]

# Migrations need TypeScript sources and dev dependencies, so they run from
# a stage that has both.
FROM builder AS migrate
CMD ["npm", "run", "migration:run"]
```

- [ ] **Step 2: Add the `migrate` and `api` services to `docker-compose.yml`**

Insert before the `volumes:` block:

```yaml
  migrate:
    build:
      context: .
      target: migrate
    environment:
      DATABASE_URL: postgres://clinic:clinic@postgres:5432/clinic
      NODE_ENV: production
    depends_on:
      postgres:
        condition: service_healthy
    restart: 'no'

  api:
    build:
      context: .
      target: runtime
    environment:
      NODE_ENV: production
      PORT: 3000
      DATABASE_URL: postgres://clinic:clinic@postgres:5432/clinic
      REDIS_URL: redis://redis:6379
      JWT_SECRET: ${JWT_SECRET}
      JWT_EXPIRES_IN: ${JWT_EXPIRES_IN}
      CLINIC_TZ: ${CLINIC_TZ}
    ports:
      - '3000:3000'
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    healthcheck:
      test:
        - CMD-SHELL
        - "node -e \"fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 15s
```

`service_completed_successfully` is what keeps `synchronize: true` unnecessary:
nothing serves traffic until migrations have exited 0. See
`docs/INFRASTRUCTURE/Deployment.md`.

- [ ] **Step 3: Build and start the full stack**

```bash
docker compose up --build -d
docker compose ps
```

Expected: `migrate` shows `exited (0)`; `api` shows `healthy`.

- [ ] **Step 4: Verify the API responds through the container**

```bash
curl http://localhost:3000/health
```

Expected: `{"status":"ok","database":"up"}`

- [ ] **Step 5: Verify a failed migration stops the stack cleanly**

```bash
docker compose down
docker compose run --rm -e DATABASE_URL=postgres://clinic:wrong@postgres:5432/clinic migrate
```

Expected: non-zero exit with an authentication error. This is the behaviour that
makes a bad migration obvious instead of leaving replicas crash-looping.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile docker-compose.yml
git commit -m "chore(infra): containerise the API and run migrations as a one-shot service"
```

---

## Definition of Done

- [ ] `docker compose up --build` starts postgres, redis, migrate and api, with
      `api` reporting healthy.
- [ ] `curl localhost:3000/health` returns `{"status":"ok","database":"up"}`.
- [ ] `npm test` passes (13 unit tests).
- [ ] `npm run test:e2e` passes against `clinic_test`.
- [ ] `npm run migration:revert` followed by `npm run migration:run` succeeds.
- [ ] `grep -r "synchronize: true" src/` returns nothing.
- [ ] `grep -rn "new Date()" src/ --include=*.ts` matches only
      `src/common/clock/clock.ts`.
- [ ] Starting the app with `CLINIC_TZ=Mars/Olympus` fails at boot with a message
      naming `CLINIC_TZ`.

The last two are the ones worth actually running. They are the invariants this
plan exists to establish, and both are easy to erode later.

---

## Next

Plan 2 (Auth & roles) builds on: `AppConfigModule` for `JWT_SECRET`,
`DatabaseModule` for entities and migrations, `AppException` for `401`/`403`
bodies, and `Clock` for token issuance timestamps.
