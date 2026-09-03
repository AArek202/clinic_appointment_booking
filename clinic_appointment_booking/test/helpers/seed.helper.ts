import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { UserRole } from '../../src/common/enums/role.enum';

export interface SeededActor {
  userId: string;
  token: string;
  doctorId?: string;
  patientId?: string;
}

/**
 * Signs tokens with the same secret the running app verifies with.
 *
 * The tests build tokens directly instead of calling POST /auth/login, so this
 * suite tests the schedule endpoints and not Plan 2's login response shape. The
 * payload is the JwtPayload from docs/PLANS/00-interfaces.md: sub and role only.
 */
export function createJwtService(): JwtService {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error('JWT_SECRET is required to sign test tokens');
  }

  return new JwtService({ secret, signOptions: { expiresIn: '1h' } });
}

/**
 * Clears every seeded row.
 *
 * `users` is the root of every foreign-key chain in this schema, so CASCADE
 * reaches doctors, patients, schedules, blocks and appointments. Tables added
 * by later plans hang off the same chain and need no change here.
 */
export async function truncateAll(dataSource: DataSource): Promise<void> {
  await dataSource.query('TRUNCATE TABLE users CASCADE');
}

async function insertUser(
  dataSource: DataSource,
  role: UserRole,
): Promise<string> {
  const userId = randomUUID();

  // created_at and updated_at are written explicitly so this helper does not
  // depend on whether Plan 2's migration gave them defaults.
  await dataSource.query(
    `INSERT INTO users (id, first_name, last_name, email, password_hash, role, created_at, updated_at)
     VALUES ($1, 'Test', $2, $3, 'not-a-real-hash', $4, now(), now())`,
    [userId, role, `${userId}@example.test`, role],
  );

  return userId;
}

export async function seedAdmin(
  dataSource: DataSource,
  jwt: JwtService,
): Promise<SeededActor> {
  const userId = await insertUser(dataSource, UserRole.Admin);

  return { userId, token: jwt.sign({ sub: userId, role: UserRole.Admin }) };
}

export async function seedDoctor(
  dataSource: DataSource,
  jwt: JwtService,
): Promise<SeededActor> {
  const userId = await insertUser(dataSource, UserRole.Doctor);
  const doctorId = randomUUID();

  await dataSource.query(
    `INSERT INTO doctors (id, user_id, specialization, achievements)
     VALUES ($1, $2, 'Cardiology', NULL)`,
    [doctorId, userId],
  );

  return {
    userId,
    doctorId,
    token: jwt.sign({ sub: userId, role: UserRole.Doctor }),
  };
}

export async function seedPatient(
  dataSource: DataSource,
  jwt: JwtService,
): Promise<SeededActor> {
  const userId = await insertUser(dataSource, UserRole.Patient);
  const patientId = randomUUID();

  await dataSource.query(
    `INSERT INTO patients (id, user_id, phone_number, date_of_birth, gender)
     VALUES ($1, $2, NULL, NULL, NULL)`,
    [patientId, userId],
  );

  return {
    userId,
    patientId,
    token: jwt.sign({ sub: userId, role: UserRole.Patient }),
  };
}
