# Auth & Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** JWT authentication with three roles (ADMIN, DOCTOR, PATIENT), the
`users`/`doctors`/`patients` tables, and the reusable authorization primitives
every later plan depends on — including the "ADMIN or the addressed doctor"
ownership rule.

**Architecture:** Controller → service → repository per `docs/ARCHITECTURE.md`.
A globally registered `JwtAuthGuard` protects everything by default, with
`@Public()` as the explicit opt-out. `RolesGuard` handles coarse role checks;
`DoctorOwnershipGuard` handles the subject-specific check used by schedules,
blocks and analytics.

**Tech Stack:** NestJS 11, `@nestjs/jwt`, `bcryptjs`, TypeORM, PostgreSQL 16,
Jest 30, Supertest.

## Global Constraints

- `synchronize: true` is forbidden everywhere. Schema changes go through
  migrations. (`docs/STACK.md`)
- Entity, column, enum and constraint names come from
  `docs/PLANS/00-interfaces.md`. That file wins over this one on any conflict.
- Enums are stored as `text` with a `CHECK` constraint, not native PostgreSQL
  enum types. (`docs/PLANS/00-interfaces.md`)
- Passwords are never stored in plain text. (`docs/FEATURES/Auth.md`)
- `JWT_SECRET` comes from configuration and is at least 32 characters, already
  validated at boot by Plan 1.
- Public registration creates a PATIENT only. The client can never choose a role.
  (`docs/FEATURES/Auth.md`)
- No service reads time via `new Date()`. Time comes from the injected `Clock`.
- Do not implement OAuth, refresh token rotation, email verification or password
  reset. Auth is supporting functionality. (`docs/FEATURES/Auth.md`)
- Commit messages follow `docs/DEVELOPMENT.md`.

---

## File Structure

**Created:**

```text
src/common/enums/role.enum.ts

src/users/
  user.entity.ts
  users.repository.ts
  users.module.ts

src/doctors/
  doctor.entity.ts
  doctors.repository.ts
  doctors.service.ts
  doctors.controller.ts
  doctors.module.ts
  dto/create-doctor.dto.ts

src/patients/
  patient.entity.ts
  patients.repository.ts
  patients.module.ts

src/auth/
  auth.controller.ts
  auth.service.ts
  auth.module.ts
  password.service.ts
  jwt-payload.interface.ts
  auth-user.interface.ts
  auth-user.resolver.ts
  dto/register.dto.ts
  dto/login.dto.ts
  guards/jwt-auth.guard.ts
  guards/roles.guard.ts
  guards/doctor-ownership.guard.ts
  decorators/public.decorator.ts
  decorators/roles.decorator.ts
  decorators/current-user.decorator.ts

src/database/migrations/1756800100000-CreateUsersDoctorsPatients.ts
src/database/seeds/create-admin.ts

test/auth.e2e-spec.ts
test/doctors.e2e-spec.ts
```

**Modified:** `src/app.module.ts`, `package.json`, `.env.example`.

Users, doctors and patients are separate modules because they are separate
tables with separate lifecycles. `auth/` owns credentials and identity;
`doctors/` owns the doctor profile and is where later plans hang schedules.

---

## Task 1: Users, doctors and patients schema

**Files:**
- Create: `src/common/enums/role.enum.ts`
- Create: `src/users/user.entity.ts`
- Create: `src/doctors/doctor.entity.ts`
- Create: `src/patients/patient.entity.ts`
- Create: `src/database/migrations/1756800100000-CreateUsersDoctorsPatients.ts`

**Interfaces:**
- Consumes: `DatabaseModule` (Plan 1).
- Produces: `UserRole` enum; `User`, `Doctor`, `Patient` entities with the exact
  properties in `docs/PLANS/00-interfaces.md`; tables `users`, `doctors`,
  `patients`; constraints `users_email_unique`, `doctors_user_id_unique`,
  `patients_user_id_unique`.

- [ ] **Step 1: Create the role enum**

```ts
// src/common/enums/role.enum.ts
export enum UserRole {
  Admin = 'ADMIN',
  Doctor = 'DOCTOR',
  Patient = 'PATIENT',
}
```

- [ ] **Step 2: Create the User entity**

```ts
// src/users/user.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserRole } from '../common/enums/role.enum';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'first_name', type: 'text' })
  firstName!: string;

  @Column({ name: 'last_name', type: 'text' })
  lastName!: string;

  /** Always stored lowercased so uniqueness is case-insensitive. */
  @Column({ type: 'text', unique: true })
  email!: string;

  @Column({ name: 'password_hash', type: 'text' })
  passwordHash!: string;

  @Column({ type: 'text' })
  role!: UserRole;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
```

- [ ] **Step 3: Create the Doctor and Patient entities**

```ts
// src/doctors/doctor.entity.ts
import { Column, Entity, JoinColumn, OneToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../users/user.entity';

@Entity('doctors')
export class Doctor {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid', unique: true })
  userId!: string;

  @Column({ type: 'text' })
  specialization!: string;

  @Column({ type: 'text', nullable: true })
  achievements!: string | null;

  @OneToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user?: User;
}
```

```ts
// src/patients/patient.entity.ts
import { Column, Entity, JoinColumn, OneToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../users/user.entity';

@Entity('patients')
export class Patient {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid', unique: true })
  userId!: string;

  @Column({ name: 'phone_number', type: 'text', nullable: true })
  phoneNumber!: string | null;

  @Column({ name: 'date_of_birth', type: 'date', nullable: true })
  dateOfBirth!: string | null;

  @Column({ type: 'text', nullable: true })
  gender!: string | null;

  @Column({ name: 'has_insurance', type: 'boolean', default: false })
  hasInsurance!: boolean;

  @OneToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user?: User;
}
```

`dateOfBirth` is typed `string` because PostgreSQL `date` has no time or zone,
and mapping it to a JavaScript `Date` would silently attach midnight in some
timezone and invite off-by-one-day bugs.

- [ ] **Step 4: Write the migration**

```ts
// src/database/migrations/1756800100000-CreateUsersDoctorsPatients.ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUsersDoctorsPatients1756800100000 implements MigrationInterface {
  name = 'CreateUsersDoctorsPatients1756800100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE users (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        first_name    text NOT NULL,
        last_name     text NOT NULL,
        email         text NOT NULL,
        password_hash text NOT NULL,
        role          text NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT users_email_unique UNIQUE (email),
        CONSTRAINT users_role_valid CHECK (role IN ('ADMIN', 'DOCTOR', 'PATIENT'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE doctors (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id        uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        specialization text NOT NULL,
        achievements   text,
        CONSTRAINT doctors_user_id_unique UNIQUE (user_id)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE patients (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id        uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        phone_number   text,
        date_of_birth  date,
        gender         text,
        has_insurance  boolean NOT NULL DEFAULT false,
        CONSTRAINT patients_user_id_unique UNIQUE (user_id)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE patients`);
    await queryRunner.query(`DROP TABLE doctors`);
    await queryRunner.query(`DROP TABLE users`);
  }
}
```

`ON DELETE RESTRICT`, not `CASCADE`. A user with appointment history must not be
deletable by accident; removing them has to be a deliberate act.

- [ ] **Step 5: Run the migration and inspect the schema**

```bash
npm run migration:run
docker compose exec postgres psql -U clinic -d clinic -c "\d users"
```

Expected: table `users` exists with `users_email_unique` and `users_role_valid`
listed under indexes/constraints.

- [ ] **Step 6: Verify the migration reverts and re-runs**

```bash
npm run migration:revert
npm run migration:run
```

Expected: both succeed, no error about existing tables.

- [ ] **Step 7: Commit**

```bash
git add src/common/enums src/users src/doctors src/patients src/database/migrations
git commit -m "feat(database): add users, doctors and patients tables"
```

---

## Task 2: Password hashing

**Files:**
- Create: `src/auth/password.service.ts`
- Test: `src/auth/password.service.spec.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `PasswordService` with `hash(plain: string): Promise<string>` and
  `verify(plain: string, hash: string): Promise<boolean>`.

- [ ] **Step 1: Install dependencies**

```bash
npm install @nestjs/jwt bcryptjs
npm install --save-dev @types/bcryptjs
```

`bcryptjs`, not `bcrypt`. `bcrypt` is a native module requiring `node-gyp`,
which means Python and a C++ toolchain — awkward on Windows and on
`node:22-alpine`, where it needs extra build packages in the Docker image.
`bcryptjs` is pure JavaScript with an identical algorithm. It is slower, which is
irrelevant for a login endpoint and for tests, and it removes a whole class of
"works on my machine" failure.

- [ ] **Step 2: Write the failing test**

```ts
// src/auth/password.service.spec.ts
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('produces a hash that is not the plain password', async () => {
    const hash = await service.hash('correct-horse-battery');

    expect(hash).not.toBe('correct-horse-battery');
    expect(hash.length).toBeGreaterThan(50);
  });

  it('verifies a correct password', async () => {
    const hash = await service.hash('correct-horse-battery');

    await expect(service.verify('correct-horse-battery', hash)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await service.hash('correct-horse-battery');

    await expect(service.verify('wrong', hash)).resolves.toBe(false);
  });

  it('produces a different hash each time for the same password', async () => {
    const first = await service.hash('same-password');
    const second = await service.hash('same-password');

    expect(first).not.toBe(second);
  });
});
```

The last test asserts the salt is doing its job. Identical hashes for identical
passwords would mean an attacker who obtained the table could spot users sharing
a password.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest src/auth/password.service.spec.ts`
Expected: FAIL — `Cannot find module './password.service'`.

- [ ] **Step 4: Implement the service**

```ts
// src/auth/password.service.ts
import { Injectable } from '@nestjs/common';
import { compare, hash } from 'bcryptjs';

const SALT_ROUNDS = 10;

@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> {
    return hash(plain, SALT_ROUNDS);
  }

  verify(plain: string, passwordHash: string): Promise<boolean> {
    return compare(plain, passwordHash);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/auth/password.service.spec.ts`
Expected: PASS — 4 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/auth/password.service.ts src/auth/password.service.spec.ts
git commit -m "feat(auth): add password hashing service"
```

---

## Task 3: Repositories

**Files:**
- Create: `src/users/users.repository.ts`
- Create: `src/users/users.module.ts`
- Create: `src/doctors/doctors.repository.ts`
- Create: `src/patients/patients.repository.ts`

**Interfaces:**
- Consumes: entities from Task 1.
- Produces: `UsersRepository` (`findByEmail`, `findById`, `createUser`),
  `DoctorsRepository` (`findByUserId`, `findById`, `findAll`, `createDoctor`),
  `PatientsRepository` (`findByUserId`, `createPatient`). Each `create*` accepts
  an optional `EntityManager` so callers can compose them in one transaction.

- [ ] **Step 1: Implement `UsersRepository`**

```ts
// src/users/users.repository.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { UserRole } from '../common/enums/role.enum';
import { User } from './user.entity';

export interface CreateUserParams {
  firstName: string;
  lastName: string;
  email: string;
  passwordHash: string;
  role: UserRole;
}

@Injectable()
export class UsersRepository {
  constructor(@InjectRepository(User) private readonly repo: Repository<User>) {}

  findByEmail(email: string): Promise<User | null> {
    return this.repo.findOne({ where: { email: email.trim().toLowerCase() } });
  }

  findById(id: string): Promise<User | null> {
    return this.repo.findOne({ where: { id } });
  }

  createUser(params: CreateUserParams, manager?: EntityManager): Promise<User> {
    const repo = manager ? manager.getRepository(User) : this.repo;
    return repo.save(
      repo.create({ ...params, email: params.email.trim().toLowerCase() }),
    );
  }
}
```

Lowercasing happens in the repository, on both read and write. Doing it in the
service would let a future caller bypass it and create a duplicate account
differing only in case.

- [ ] **Step 2: Implement `DoctorsRepository`**

```ts
// src/doctors/doctors.repository.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Doctor } from './doctor.entity';

export interface CreateDoctorParams {
  userId: string;
  specialization: string;
  achievements?: string | null;
}

@Injectable()
export class DoctorsRepository {
  constructor(@InjectRepository(Doctor) private readonly repo: Repository<Doctor>) {}

  findById(id: string): Promise<Doctor | null> {
    return this.repo.findOne({ where: { id } });
  }

  findByUserId(userId: string): Promise<Doctor | null> {
    return this.repo.findOne({ where: { userId } });
  }

  findAll(): Promise<Doctor[]> {
    return this.repo.find({ relations: { user: true }, order: { id: 'ASC' } });
  }

  createDoctor(params: CreateDoctorParams, manager?: EntityManager): Promise<Doctor> {
    const repo = manager ? manager.getRepository(Doctor) : this.repo;
    return repo.save(repo.create({ achievements: null, ...params }));
  }
}
```

- [ ] **Step 3: Implement `PatientsRepository`**

```ts
// src/patients/patients.repository.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Patient } from './patient.entity';

export interface CreatePatientParams {
  userId: string;
  phoneNumber?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
}

@Injectable()
export class PatientsRepository {
  constructor(@InjectRepository(Patient) private readonly repo: Repository<Patient>) {}

  findById(id: string): Promise<Patient | null> {
    return this.repo.findOne({ where: { id } });
  }

  findByUserId(userId: string): Promise<Patient | null> {
    return this.repo.findOne({ where: { userId } });
  }

  createPatient(params: CreatePatientParams, manager?: EntityManager): Promise<Patient> {
    const repo = manager ? manager.getRepository(Patient) : this.repo;
    return repo.save(
      repo.create({
        phoneNumber: null,
        dateOfBirth: null,
        gender: null,
        hasInsurance: false,
        ...params,
      }),
    );
  }
}
```

- [ ] **Step 4: Create the modules**

```ts
// src/users/users.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './user.entity';
import { UsersRepository } from './users.repository';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [UsersRepository],
  exports: [UsersRepository],
})
export class UsersModule {}
```

```ts
// src/patients/patients.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Patient } from './patient.entity';
import { PatientsRepository } from './patients.repository';

@Module({
  imports: [TypeOrmModule.forFeature([Patient])],
  providers: [PatientsRepository],
  exports: [PatientsRepository],
})
export class PatientsModule {}
```

`DoctorsModule` is created in Task 6, once it has a controller and service.

- [ ] **Step 5: Commit**

```bash
git add src/users src/patients src/doctors/doctors.repository.ts
git commit -m "feat(users): add users, doctors and patients repositories"
```

---

## Task 4: Registration and login

**Files:**
- Create: `src/auth/dto/register.dto.ts`
- Create: `src/auth/dto/login.dto.ts`
- Create: `src/auth/jwt-payload.interface.ts`
- Create: `src/auth/auth.service.ts`
- Create: `src/auth/auth.controller.ts`
- Create: `src/auth/auth.module.ts`
- Test: `test/auth.e2e-spec.ts`

**Interfaces:**
- Consumes: `PasswordService`, `UsersRepository`, `PatientsRepository`,
  `AppException`/`ErrorCode` (Plan 1), `ConfigService`.
- Produces: `POST /auth/register`, `POST /auth/login` returning
  `{ accessToken: string }`; `JwtPayload { sub, role }`; `AuthService.register`,
  `AuthService.login`.

- [ ] **Step 1: Write the DTOs**

```ts
// src/auth/dto/register.dto.ts
import { IsEmail, IsISO8601, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phoneNumber?: string;

  @IsOptional()
  @IsISO8601()
  dateOfBirth?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  gender?: string;
}
```

There is deliberately no `role` property. Combined with the `whitelist` and
`forbidNonWhitelisted` pipe from Plan 1, a request sending `role: "ADMIN"` is
rejected with 400 rather than silently ignored — the difference between a
vulnerability and an error.

`MaxLength(72)` on the password is not arbitrary: bcrypt truncates input beyond
72 bytes, so accepting more would silently ignore the extra characters.

```ts
// src/auth/dto/login.dto.ts
import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}
```

- [ ] **Step 2: Write the JWT payload interface**

```ts
// src/auth/jwt-payload.interface.ts
import { UserRole } from '../common/enums/role.enum';

export interface JwtPayload {
  /** users.id */
  sub: string;
  role: UserRole;
}
```

The payload deliberately carries no `doctorId` or `patientId`. Those are
resolved from the database on each request, so a token issued before a profile
changed cannot assert stale ownership.

- [ ] **Step 3: Write the failing e2e test**

```ts
// test/auth.e2e-spec.ts
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

describe('Auth', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    dataSource = app.get(DataSource);
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE patients, doctors, users CASCADE');
  });

  afterAll(async () => {
    await app.close();
  });

  const validRegistration = {
    firstName: 'Nadia',
    lastName: 'Hassan',
    email: 'Nadia.Hassan@example.com',
    password: 'correct-horse-battery',
  };

  it('registers a patient and stores the email lowercased', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send(validRegistration)
      .expect(201);

    expect(response.body).toEqual({
      id: expect.any(String),
      email: 'nadia.hassan@example.com',
      role: 'PATIENT',
    });

    const [row] = await dataSource.query('SELECT role, password_hash FROM users');
    expect(row.role).toBe('PATIENT');
    expect(row.password_hash).not.toContain('correct-horse-battery');
  });

  it('creates a matching patient profile', async () => {
    await request(app.getHttpServer()).post('/auth/register').send(validRegistration).expect(201);

    const [{ count }] = await dataSource.query('SELECT count(*)::int AS count FROM patients');
    expect(count).toBe(1);
  });

  it('rejects a request attempting to set its own role', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ ...validRegistration, role: 'ADMIN' })
      .expect(400);
  });

  it('rejects a duplicate email regardless of case', async () => {
    await request(app.getHttpServer()).post('/auth/register').send(validRegistration).expect(201);

    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ ...validRegistration, email: 'NADIA.HASSAN@example.com' })
      .expect(409);

    expect(response.body.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('logs in with correct credentials and returns a token', async () => {
    await request(app.getHttpServer()).post('/auth/register').send(validRegistration).expect(201);

    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: validRegistration.email, password: validRegistration.password })
      .expect(200);

    expect(typeof response.body.accessToken).toBe('string');
  });

  it('rejects a wrong password with 401', async () => {
    await request(app.getHttpServer()).post('/auth/register').send(validRegistration).expect(201);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: validRegistration.email, password: 'nope' })
      .expect(401);
  });

  it('rejects an unknown email with 401, not 404', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'nope' })
      .expect(401);
  });
});
```

The last test is a security assertion: a 404 for unknown emails and 401 for wrong
passwords would let anyone enumerate registered accounts.

- [ ] **Step 4: Add the `EmailAlreadyRegistered` error code**

Add to `src/common/errors/error-code.enum.ts`:

```ts
  EmailAlreadyRegistered = 'EMAIL_ALREADY_REGISTERED',
```

- [ ] **Step 5: Run the test to verify it fails**

```bash
docker compose --profile test up -d postgres-test
npm run test:e2e -- auth
```

Expected: FAIL — `Cannot POST /auth/register` (404).

- [ ] **Step 6: Implement `AuthService`**

```ts
// src/auth/auth.service.ts
import { HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { UserRole } from '../common/enums/role.enum';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-code.enum';
import { PatientsRepository } from '../patients/patients.repository';
import { UsersRepository } from '../users/users.repository';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from './jwt-payload.interface';
import { PasswordService } from './password.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersRepository,
    private readonly patients: PatientsRepository,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
    private readonly dataSource: DataSource,
  ) {}

  async register(dto: RegisterDto): Promise<{ id: string; email: string; role: UserRole }> {
    const existing = await this.users.findByEmail(dto.email);
    if (existing) {
      throw new AppException(
        ErrorCode.EmailAlreadyRegistered,
        'An account with this email already exists.',
        HttpStatus.CONFLICT,
      );
    }

    const passwordHash = await this.passwords.hash(dto.password);

    // The user row and the patient profile must appear together or not at all.
    const user = await this.dataSource.transaction(async (manager) => {
      const created = await this.users.createUser(
        {
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email,
          passwordHash,
          // Role is set here, never taken from the request.
          role: UserRole.Patient,
        },
        manager,
      );

      await this.patients.createPatient(
        {
          userId: created.id,
          phoneNumber: dto.phoneNumber ?? null,
          dateOfBirth: dto.dateOfBirth ?? null,
          gender: dto.gender ?? null,
        },
        manager,
      );

      return created;
    });

    return { id: user.id, email: user.email, role: user.role };
  }

  async login(dto: LoginDto): Promise<{ accessToken: string }> {
    const user = await this.users.findByEmail(dto.email);

    // Same response for unknown email and wrong password, so the endpoint
    // cannot be used to enumerate registered accounts.
    const valid = user ? await this.passwords.verify(dto.password, user.passwordHash) : false;
    if (!user || !valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const payload: JwtPayload = { sub: user.id, role: user.role };
    return { accessToken: await this.jwt.signAsync(payload) };
  }
}
```

The pre-check on email is for a friendly message only; `users_email_unique` is
what actually prevents duplicates under concurrent registration. Two simultaneous
registrations for the same address will have one fail on the constraint, which
surfaces as a 500 — acceptable for registration, and noted in the README as a
place where booking's constraint-name mapping was worth doing and this was not.

- [ ] **Step 7: Implement the controller and module**

```ts
// src/auth/auth.controller.ts
import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthUser } from './auth-user.interface';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }
}
```

`@HttpCode(HttpStatus.OK)` on login because a POST defaults to 201 in Nest, and
logging in creates no resource.

```ts
// src/auth/auth.module.ts
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { DoctorsModule } from '../doctors/doctors.module';
import { PatientsModule } from '../patients/patients.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthUserResolver } from './auth-user.resolver';
import { PasswordService } from './password.service';

@Module({
  imports: [
    UsersModule,
    PatientsModule,
    DoctorsModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.getOrThrow<string>('JWT_EXPIRES_IN') },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, AuthUserResolver],
  exports: [AuthUserResolver, JwtModule],
})
export class AuthModule {}
```

`AuthUserResolver`, `Public`, `CurrentUser` and `AuthUser` are created in Task 5.
Complete Task 5 before running the suite.

- [ ] **Step 8: Commit**

```bash
git add src/auth src/common/errors/error-code.enum.ts test/auth.e2e-spec.ts
git commit -m "feat(auth): add patient registration and JWT login"
```

---

## Task 5: Guards, decorators and request identity

**Files:**
- Create: `src/auth/auth-user.interface.ts`
- Create: `src/auth/auth-user.resolver.ts`
- Create: `src/auth/decorators/public.decorator.ts`
- Create: `src/auth/decorators/roles.decorator.ts`
- Create: `src/auth/decorators/current-user.decorator.ts`
- Create: `src/auth/guards/jwt-auth.guard.ts`
- Create: `src/auth/guards/roles.guard.ts`
- Create: `src/auth/guards/doctor-ownership.guard.ts`
- Test: `src/auth/guards/doctor-ownership.guard.spec.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `JwtService`, `UsersRepository`, `DoctorsRepository`,
  `PatientsRepository`.
- Produces: `AuthUser { userId, role, doctorId?, patientId? }`;
  `AuthUserResolver.resolve(payload: JwtPayload): Promise<AuthUser>`;
  `@Public()`, `@Roles(...)`, `@CurrentUser()`; `JwtAuthGuard` (registered
  globally), `RolesGuard` (registered globally), `DoctorOwnershipGuard` (applied
  per route). Every later plan uses these exact names.

- [ ] **Step 1: Write the AuthUser interface and resolver**

```ts
// src/auth/auth-user.interface.ts
import { UserRole } from '../common/enums/role.enum';

export interface AuthUser {
  userId: string;
  role: UserRole;
  /** Present when role is DOCTOR. */
  doctorId?: string;
  /** Present when role is PATIENT. */
  patientId?: string;
}
```

```ts
// src/auth/auth-user.resolver.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UserRole } from '../common/enums/role.enum';
import { DoctorsRepository } from '../doctors/doctors.repository';
import { PatientsRepository } from '../patients/patients.repository';
import { UsersRepository } from '../users/users.repository';
import { AuthUser } from './auth-user.interface';
import { JwtPayload } from './jwt-payload.interface';

@Injectable()
export class AuthUserResolver {
  constructor(
    private readonly users: UsersRepository,
    private readonly doctors: DoctorsRepository,
    private readonly patients: PatientsRepository,
  ) {}

  /**
   * Turns a verified token into the identity used for authorization.
   *
   * The profile ids are read from the database rather than the token, so a
   * token issued before a profile changed cannot assert stale ownership. The
   * role is also re-read, so revoking a role takes effect immediately instead
   * of when the token expires.
   */
  async resolve(payload: JwtPayload): Promise<AuthUser> {
    const user = await this.users.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }

    const authUser: AuthUser = { userId: user.id, role: user.role };

    if (user.role === UserRole.Doctor) {
      const doctor = await this.doctors.findByUserId(user.id);
      if (doctor) {
        authUser.doctorId = doctor.id;
      }
    }

    if (user.role === UserRole.Patient) {
      const patient = await this.patients.findByUserId(user.id);
      if (patient) {
        authUser.patientId = patient.id;
      }
    }

    return authUser;
  }
}
```

This costs one or two queries per request. That is a deliberate trade: the
alternative is trusting ids embedded in a token that may be a day old.

- [ ] **Step 2: Write the decorators**

```ts
// src/auth/decorators/public.decorator.ts
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

```ts
// src/auth/decorators/roles.decorator.ts
import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../../common/enums/role.enum';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
```

```ts
// src/auth/decorators/current-user.decorator.ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthUser } from '../auth-user.interface';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser =>
    context.switchToHttp().getRequest().user,
);
```

- [ ] **Step 3: Write the JWT guard**

```ts
// src/auth/guards/jwt-auth.guard.ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AuthUserResolver } from '../auth-user.resolver';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { JwtPayload } from '../jwt-payload.interface';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly resolver: AuthUserResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(header.slice('Bearer '.length));
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    (request as Request & { user: unknown }).user = await this.resolver.resolve(payload);
    return true;
  }
}
```

Registered globally, so a new endpoint is protected by default and has to opt out
explicitly. The opposite default — public unless annotated — leaves a forgotten
decorator as an open endpoint.

- [ ] **Step 4: Write the roles guard**

```ts
// src/auth/guards/roles.guard.ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../common/enums/role.enum';
import { AuthUser } from '../auth-user.interface';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      return true;
    }

    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException('Your role cannot perform this action');
    }

    return true;
  }
}
```

- [ ] **Step 5: Write the failing ownership guard test**

```ts
// src/auth/guards/doctor-ownership.guard.spec.ts
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { UserRole } from '../../common/enums/role.enum';
import { AuthUser } from '../auth-user.interface';
import { DoctorOwnershipGuard } from './doctor-ownership.guard';

function contextFor(user: AuthUser | undefined, doctorId: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user, params: { doctorId } }) }),
  } as unknown as ExecutionContext;
}

describe('DoctorOwnershipGuard', () => {
  const guard = new DoctorOwnershipGuard();
  const doctorA = 'aaaaaaaa-0000-0000-0000-000000000001';
  const doctorB = 'bbbbbbbb-0000-0000-0000-000000000002';

  it('allows an admin to act on any doctor', () => {
    const user: AuthUser = { userId: 'u1', role: UserRole.Admin };

    expect(guard.canActivate(contextFor(user, doctorA))).toBe(true);
  });

  it('allows a doctor to act on their own record', () => {
    const user: AuthUser = { userId: 'u2', role: UserRole.Doctor, doctorId: doctorA };

    expect(guard.canActivate(contextFor(user, doctorA))).toBe(true);
  });

  it("forbids a doctor acting on another doctor's record", () => {
    const user: AuthUser = { userId: 'u3', role: UserRole.Doctor, doctorId: doctorB };

    expect(() => guard.canActivate(contextFor(user, doctorA))).toThrow(ForbiddenException);
  });

  it('forbids a patient', () => {
    const user: AuthUser = { userId: 'u4', role: UserRole.Patient, patientId: 'p1' };

    expect(() => guard.canActivate(contextFor(user, doctorA))).toThrow(ForbiddenException);
  });

  it('forbids a doctor with no linked profile', () => {
    const user: AuthUser = { userId: 'u5', role: UserRole.Doctor };

    expect(() => guard.canActivate(contextFor(user, doctorA))).toThrow(ForbiddenException);
  });
});
```

The last case matters: a DOCTOR user whose profile row is missing has
`doctorId === undefined`, and `undefined === undefined` would pass a naive
equality check against a missing route param.

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx jest src/auth/guards/doctor-ownership.guard.spec.ts`
Expected: FAIL — `Cannot find module './doctor-ownership.guard'`.

- [ ] **Step 7: Implement the ownership guard**

```ts
// src/auth/guards/doctor-ownership.guard.ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { UserRole } from '../../common/enums/role.enum';
import { AuthUser } from '../auth-user.interface';

/**
 * Passes when the caller is an ADMIN, or is the doctor named by the
 * `:doctorId` route parameter.
 *
 * One rule, reused by schedules, blocks and analytics.
 */
@Injectable()
export class DoctorOwnershipGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthUser; params: Record<string, string> }>();

    const user = request.user;
    const doctorId = request.params.doctorId;

    if (user?.role === UserRole.Admin) {
      return true;
    }

    if (user?.role === UserRole.Doctor && user.doctorId && user.doctorId === doctorId) {
      return true;
    }

    throw new ForbiddenException('You cannot act on this doctor');
  }
}
```

The `user.doctorId &&` clause is what stops an undefined profile id from
matching an absent route parameter.

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx jest src/auth/guards/doctor-ownership.guard.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 9: Register the global guards**

Replace `src/app.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { ClockModule } from './common/clock/clock.module';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { DoctorsModule } from './doctors/doctors.module';
import { HealthModule } from './health/health.module';
import { PatientsModule } from './patients/patients.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    ClockModule,
    HealthModule,
    AuthModule,
    UsersModule,
    DoctorsModule,
    PatientsModule,
  ],
  providers: [
    // Order matters: authentication must populate request.user before
    // RolesGuard reads its role.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
```

- [ ] **Step 10: Mark the health endpoint public**

In `src/health/health.controller.ts`, add `@Public()` to the `check` handler and
import it from `../auth/decorators/public.decorator`. Without this, the Plan 1
health test now fails with 401 — and so would the compose healthcheck.

- [ ] **Step 11: Run the full suite**

```bash
npm test
npm run test:e2e
```

Expected: all unit tests pass; `health` and `auth` e2e specs pass.

- [ ] **Step 12: Commit**

```bash
git add src/auth src/app.module.ts src/health
git commit -m "feat(auth): add JWT, role and doctor ownership guards"
```

---

## Task 6: Admin-created doctors

**Files:**
- Create: `src/doctors/dto/create-doctor.dto.ts`
- Create: `src/doctors/doctors.service.ts`
- Create: `src/doctors/doctors.controller.ts`
- Create: `src/doctors/doctors.module.ts`
- Create: `src/database/seeds/create-admin.ts`
- Test: `test/doctors.e2e-spec.ts`
- Modify: `package.json`, `.env.example`

**Interfaces:**
- Consumes: everything above.
- Produces: `POST /doctors` (ADMIN only), `GET /doctors`, `GET /doctors/:id`;
  `DoctorsService.createDoctor`; `npm run seed:admin`. `DoctorsModule` exports
  `DoctorsRepository` so `AuthModule` and later plans can inject it.

- [ ] **Step 1: Write the DTO**

```ts
// src/doctors/dto/create-doctor.dto.ts
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateDoctorDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  specialization!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  achievements?: string;
}
```

- [ ] **Step 2: Write the failing e2e test**

```ts
// test/doctors.e2e-spec.ts
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { UserRole } from '../src/common/enums/role.enum';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { PasswordService } from '../src/auth/password.service';

describe('Doctors', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const adminCredentials = { email: 'admin@clinic.test', password: 'admin-password-1' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    dataSource = app.get(DataSource);
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE patients, doctors, users CASCADE');

    const hash = await app.get(PasswordService).hash(adminCredentials.password);
    await dataSource.query(
      `INSERT INTO users (first_name, last_name, email, password_hash, role)
       VALUES ('Root', 'Admin', $1, $2, $3)`,
      [adminCredentials.email, hash, UserRole.Admin],
    );
  });

  afterAll(async () => {
    await app.close();
  });

  async function tokenFor(email: string, password: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    return response.body.accessToken as string;
  }

  const newDoctor = {
    firstName: 'Omar',
    lastName: 'Fahmy',
    email: 'omar.fahmy@clinic.test',
    password: 'doctor-password-1',
    specialization: 'Cardiology',
  };

  it('lets an admin create a doctor with a linked user account', async () => {
    const token = await tokenFor(adminCredentials.email, adminCredentials.password);

    const response = await request(app.getHttpServer())
      .post('/doctors')
      .set('Authorization', `Bearer ${token}`)
      .send(newDoctor)
      .expect(201);

    expect(response.body).toEqual({
      id: expect.any(String),
      specialization: 'Cardiology',
      email: 'omar.fahmy@clinic.test',
    });

    const [row] = await dataSource.query(
      `SELECT u.role FROM doctors d JOIN users u ON u.id = d.user_id`,
    );
    expect(row.role).toBe('DOCTOR');
  });

  it('rejects doctor creation by a patient with 403', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        firstName: 'Nadia',
        lastName: 'Hassan',
        email: 'nadia@clinic.test',
        password: 'patient-password-1',
      })
      .expect(201);

    const token = await tokenFor('nadia@clinic.test', 'patient-password-1');

    await request(app.getHttpServer())
      .post('/doctors')
      .set('Authorization', `Bearer ${token}`)
      .send(newDoctor)
      .expect(403);
  });

  it('rejects doctor creation with no token at all', async () => {
    await request(app.getHttpServer()).post('/doctors').send(newDoctor).expect(401);
  });

  it('reports the created doctor id on /auth/me for that doctor', async () => {
    const adminToken = await tokenFor(adminCredentials.email, adminCredentials.password);
    const created = await request(app.getHttpServer())
      .post('/doctors')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(newDoctor)
      .expect(201);

    const doctorToken = await tokenFor(newDoctor.email, newDoctor.password);
    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${doctorToken}`)
      .expect(200);

    expect(me.body).toEqual({
      userId: expect.any(String),
      role: 'DOCTOR',
      doctorId: created.body.id,
    });
  });
});
```

The last test is the one that proves `AuthUserResolver` works, and it is what
every ownership check in Plans 3, 4, 5 and 8 depends on.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test:e2e -- doctors`
Expected: FAIL — `Cannot POST /doctors` (404).

- [ ] **Step 4: Implement the service**

```ts
// src/doctors/doctors.service.ts
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PasswordService } from '../auth/password.service';
import { UserRole } from '../common/enums/role.enum';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-code.enum';
import { UsersRepository } from '../users/users.repository';
import { Doctor } from './doctor.entity';
import { DoctorsRepository } from './doctors.repository';
import { CreateDoctorDto } from './dto/create-doctor.dto';

@Injectable()
export class DoctorsService {
  constructor(
    private readonly doctors: DoctorsRepository,
    private readonly users: UsersRepository,
    private readonly passwords: PasswordService,
    private readonly dataSource: DataSource,
  ) {}

  async createDoctor(dto: CreateDoctorDto): Promise<Doctor> {
    const existing = await this.users.findByEmail(dto.email);
    if (existing) {
      throw new AppException(
        ErrorCode.EmailAlreadyRegistered,
        'An account with this email already exists.',
        HttpStatus.CONFLICT,
      );
    }

    const passwordHash = await this.passwords.hash(dto.password);

    // A doctor without a user account cannot log in, and a DOCTOR user without
    // a profile cannot own a schedule. Both rows commit together or neither does.
    return this.dataSource.transaction(async (manager) => {
      const user = await this.users.createUser(
        {
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email,
          passwordHash,
          role: UserRole.Doctor,
        },
        manager,
      );

      return this.doctors.createDoctor(
        {
          userId: user.id,
          specialization: dto.specialization,
          achievements: dto.achievements ?? null,
        },
        manager,
      );
    });
  }

  async findAll(): Promise<Doctor[]> {
    return this.doctors.findAll();
  }

  async findById(id: string): Promise<Doctor> {
    const doctor = await this.doctors.findById(id);
    if (!doctor) {
      throw new NotFoundException('Doctor not found');
    }
    return doctor;
  }
}
```

- [ ] **Step 5: Implement the controller and module**

```ts
// src/doctors/doctors.controller.ts
import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums/role.enum';
import { DoctorsService } from './doctors.service';
import { CreateDoctorDto } from './dto/create-doctor.dto';

@Controller('doctors')
export class DoctorsController {
  constructor(private readonly doctors: DoctorsService) {}

  @Roles(UserRole.Admin)
  @Post()
  async create(@Body() dto: CreateDoctorDto) {
    const doctor = await this.doctors.createDoctor(dto);
    return {
      id: doctor.id,
      specialization: doctor.specialization,
      email: dto.email.trim().toLowerCase(),
    };
  }

  @Get()
  async list() {
    const doctors = await this.doctors.findAll();
    return doctors.map((doctor) => ({
      id: doctor.id,
      specialization: doctor.specialization,
      firstName: doctor.user?.firstName,
      lastName: doctor.user?.lastName,
    }));
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const doctor = await this.doctors.findById(id);
    return {
      id: doctor.id,
      specialization: doctor.specialization,
      achievements: doctor.achievements,
    };
  }
}
```

Responses are mapped explicitly rather than returning entities, so
`password_hash` can never reach a client through a relation someone adds later.

```ts
// src/doctors/doctors.module.ts
import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { Doctor } from './doctor.entity';
import { DoctorsController } from './doctors.controller';
import { DoctorsRepository } from './doctors.repository';
import { DoctorsService } from './doctors.service';

@Module({
  imports: [TypeOrmModule.forFeature([Doctor]), UsersModule, forwardRef(() => AuthModule)],
  controllers: [DoctorsController],
  providers: [DoctorsRepository, DoctorsService],
  exports: [DoctorsRepository],
})
export class DoctorsModule {}
```

This is the one `forwardRef` in the project, and it is unavoidable:
`AuthModule` needs `DoctorsRepository` to resolve `doctorId`, and
`DoctorsModule` needs `PasswordService` to create a doctor's account. If it
bothers you, move `PasswordService` into `common/` — but note in the README that
you accepted the cycle rather than adding indirection to hide it.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test:e2e -- doctors`
Expected: PASS — 4 tests.

- [ ] **Step 7: Write the admin seed script**

```ts
// src/database/seeds/create-admin.ts
import 'reflect-metadata';
import { hash } from 'bcryptjs';
import { AppDataSource } from '../data-source';
import { UserRole } from '../../common/enums/role.enum';

/**
 * Creates the initial ADMIN account. Doctors are created by an admin, so
 * without this there is no way to bootstrap the system.
 * Idempotent: running it twice does not create a second admin.
 */
async function main(): Promise<void> {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required');
  }

  await AppDataSource.initialize();

  try {
    const passwordHash = await hash(password, 10);
    const result = await AppDataSource.query(
      `INSERT INTO users (first_name, last_name, email, password_hash, role)
       VALUES ('Clinic', 'Admin', $1, $2, $3)
       ON CONFLICT ON CONSTRAINT users_email_unique DO NOTHING
       RETURNING id`,
      [email.trim().toLowerCase(), passwordHash, UserRole.Admin],
    );

    console.log(
      result.length > 0
        ? `Created admin ${email}`
        : `Admin ${email} already exists, nothing to do`,
    );
  } finally {
    await AppDataSource.destroy();
  }
}

void main();
```

`ON CONFLICT ... DO NOTHING` is what makes it safe to run on every deploy.

- [ ] **Step 8: Add the script and env vars**

Add to `package.json` scripts:

```json
"seed:admin": "ts-node -r tsconfig-paths/register src/database/seeds/create-admin.ts"
```

Add to `.env.example`:

```bash
# Initial admin account, created by `npm run seed:admin`.
# Doctors are created by an admin, so this bootstraps the system.
ADMIN_EMAIL=admin@clinic.test
ADMIN_PASSWORD=change-me-admin-password
```

- [ ] **Step 9: Verify the seed is idempotent**

```bash
npm run seed:admin
npm run seed:admin
docker compose exec postgres psql -U clinic -d clinic -c "SELECT count(*) FROM users WHERE role = 'ADMIN';"
```

Expected: first run prints `Created admin`, second prints `already exists`, count
is `1`.

- [ ] **Step 10: Commit**

```bash
git add src/doctors src/database/seeds package.json .env.example test/doctors.e2e-spec.ts
git commit -m "feat(doctors): allow admins to create doctors and seed the initial admin"
```

---

## Definition of Done

- [ ] `npm test` passes, including the 5 ownership guard tests.
- [ ] `npm run test:e2e` passes `health`, `auth` and `doctors` specs.
- [ ] `POST /auth/register` with `role: "ADMIN"` in the body returns 400.
- [ ] `POST /doctors` returns 401 with no token and 403 as a patient.
- [ ] `GET /auth/me` as a doctor returns their `doctorId`.
- [ ] `npm run seed:admin` twice leaves exactly one admin.
- [ ] `npm run migration:revert` then `npm run migration:run` succeeds.
- [ ] `grep -rn "password_hash" src/ --include=*.controller.ts` returns nothing.

---

## Next

Plan 3 (Schedules & blocks) consumes: `DoctorOwnershipGuard` for
`/doctors/:doctorId/...` routes, `Doctor` for the foreign key, `@CurrentUser()`
and `AuthUser`, and `AppException`/`ErrorCode` for validation failures.
