/**
 * Concurrency proof.
 *
 * Fires N simultaneous booking requests for the SAME slot at nginx, which
 * spreads them across multiple API replicas, and asserts that PostgreSQL
 * allowed exactly one.
 *
 * Each request uses a DIFFERENT patient. Using one patient would trip
 * appointments_patient_no_overlap instead of appointments_no_overlap, and the
 * test would pass for the wrong reason.
 *
 * The target slot is computed in CLINIC_TZ. Schedules store wall-clock times
 * in that zone; `resolveSlot` does too. Setting UTC hours (as a first draft
 * of this script did) lands 10:00 UTC on 13:00 Cairo and every booking
 * returns SLOT_NOT_ON_GRID.
 */
import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { DateTime } from 'luxon';
import { DataSource } from 'typeorm';

loadDotenv();

const BASE_URL = process.env.CONCURRENCY_BASE_URL ?? 'http://localhost:8080';
const CONCURRENT_REQUESTS = Number(process.env.CONCURRENCY_REQUESTS ?? 10);
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const CLINIC_TZ = process.env.CLINIC_TZ;

interface BookingOutcome {
  status: number;
  code?: string;
}

async function post(
  path: string,
  body: unknown,
  token?: string,
): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function login(email: string, password: string): Promise<string> {
  const response = await post('/auth/login', { email, password });
  if (!response.ok) {
    throw new Error(`Login failed for ${email}: ${response.status}`);
  }
  return ((await response.json()) as { accessToken: string }).accessToken;
}

async function registerPatient(index: number): Promise<string> {
  const email = `concurrency.patient.${index}.${Date.now()}@clinic.test`;
  const password = 'concurrency-test-password';

  const response = await post('/auth/register', {
    firstName: 'Concurrency',
    lastName: `Patient${index}`,
    email,
    password,
  });
  if (response.status !== 201) {
    throw new Error(`Register failed for ${email}: ${response.status}`);
  }

  return login(email, password);
}

async function requireOk(
  response: Response,
  what: string,
): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw new Error(
      `${what} failed: ${response.status} ${JSON.stringify(body)}`,
    );
  }
  return body;
}

/** Luxon uses 1 = Monday .. 7 = Sunday; the database uses 0 = Sunday. */
function toDatabaseDayOfWeek(luxonWeekday: number): number {
  return luxonWeekday === 7 ? 0 : luxonWeekday;
}

async function main(): Promise<void> {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required');
  }
  if (!CLINIC_TZ) {
    throw new Error('CLINIC_TZ is required');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

  // A dedicated doctor, so a rerun never collides with existing data.
  const doctorEmail = `concurrency.doctor.${Date.now()}@clinic.test`;
  const doctorResponse = await post(
    '/doctors',
    {
      firstName: 'Concurrency',
      lastName: 'Doctor',
      email: doctorEmail,
      password: 'concurrency-test-password',
      specialization: 'Testing',
    },
    adminToken,
  );
  const doctorBody = await requireOk(doctorResponse, 'Create doctor');
  const doctorId = doctorBody.id as string;
  const doctorToken = await login(doctorEmail, 'concurrency-test-password');

  // One slot, on a clinic-local weekday, well in the future.
  const local = DateTime.now()
    .setZone(CLINIC_TZ)
    .plus({ days: 14 })
    .set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
  const dayOfWeek = toDatabaseDayOfWeek(local.weekday);
  const startAt = local.toUTC().toISO();
  if (!startAt) {
    throw new Error('Failed to compute target slot ISO time');
  }

  const scheduleResponse = await post(
    `/doctors/${doctorId}/schedules`,
    {
      dayOfWeek,
      startTime: '10:00:00',
      endTime: '11:00:00',
      slotDurationMinutes: 30,
    },
    doctorToken,
  );
  await requireOk(scheduleResponse, 'Create schedule');

  const tokens = await Promise.all(
    Array.from({ length: CONCURRENT_REQUESTS }, (_, index) =>
      registerPatient(index),
    ),
  );

  console.log(
    `Firing ${CONCURRENT_REQUESTS} concurrent bookings at ${BASE_URL} ` +
      `for ${startAt} (${local.toFormat('cccc HH:mm')} ${CLINIC_TZ})`,
  );

  const outcomes: BookingOutcome[] = await Promise.all(
    tokens.map(async (token) => {
      const response = await post(
        '/appointments',
        { doctorId, startAt },
        token,
      );
      const body = (await response.json().catch(() => ({}))) as {
        code?: string;
      };
      return { status: response.status, code: body.code };
    }),
  );

  const created = outcomes.filter((o) => o.status === 201).length;
  const conflicted = outcomes.filter(
    (o) => o.status === 409 && o.code === 'SLOT_ALREADY_BOOKED',
  ).length;
  const serverErrors = outcomes.filter((o) => o.status >= 500).length;
  const unexpected = outcomes.filter(
    (o) =>
      o.status !== 201 &&
      !(o.status === 409 && o.code === 'SLOT_ALREADY_BOOKED'),
  );

  const dataSource = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    synchronize: false,
  });
  await dataSource.initialize();

  const [{ count }] = (await dataSource.query(
    `SELECT count(*)::int AS count
       FROM appointments
      WHERE doctor_id = $1 AND start_at = $2 AND status = 'CONFIRMED'`,
    [doctorId, startAt],
  )) as Array<{ count: number }>;

  await dataSource.destroy();

  console.log('');
  console.log(`Successful bookings:            ${created}`);
  console.log(`Conflicted bookings (409):      ${conflicted}`);
  console.log(`Unexpected errors (5xx):        ${serverErrors}`);
  console.log(`Confirmed appointments in DB:   ${count}`);
  console.log('');

  const failures: string[] = [];
  if (created !== 1)
    failures.push(`expected exactly 1 success, got ${created}`);
  if (count !== 1)
    failures.push(`expected exactly 1 confirmed row, got ${count}`);
  if (serverErrors !== 0)
    failures.push(`expected 0 server errors, got ${serverErrors}`);
  if (conflicted !== CONCURRENT_REQUESTS - 1) {
    failures.push(
      `expected ${CONCURRENT_REQUESTS - 1} SLOT_ALREADY_BOOKED conflicts, got ${conflicted}`,
    );
  }

  if (failures.length > 0) {
    console.error('FAILED:');
    failures.forEach((failure) => console.error(`  - ${failure}`));
    if (unexpected.length > 0) {
      console.error(`  unexpected outcomes: ${JSON.stringify(unexpected)}`);
    }
    console.error(`  all outcomes: ${JSON.stringify(outcomes)}`);
    process.exit(1);
  }

  console.log('PASSED: exactly one booking succeeded.');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
