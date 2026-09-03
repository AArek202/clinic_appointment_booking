/**
 * End-to-end waiting list demonstration, for the screen recording.
 *
 * 1. Patient A books a slot.
 * 2. Patient B tries the same slot and is told it is taken.
 * 3. Patient B joins the waiting list and sees position 1.
 * 4. Patient A cancels.
 * 5. The background job assigns the slot to Patient B.
 * 6. Patient B's appointment exists with created_from = 'WAITING_LIST',
 *    and has its own reminder notification.
 *
 * Every step prints what it did and what it expected, so the recording needs
 * no editing and no separate narration of the mechanics.
 */
import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { DateTime } from 'luxon';
import { DataSource } from 'typeorm';

loadDotenv();

const BASE_URL = process.env.DEMO_BASE_URL ?? 'http://localhost:8080';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const CLINIC_TZ = process.env.CLINIC_TZ;
const POLL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 500;

interface AppointmentRow {
  id: string;
  doctorId: string;
  startAt: string;
  endAt: string;
  status: string;
}

interface WaitingListEntryRow {
  id: string;
  doctorId: string;
  slotStartAt: string;
  slotEndAt: string;
  status: string;
  position: number;
}

function step(number: number, message: string): void {
  console.log(`\n=== Step ${number}: ${message} ===`);
}

function pass(message: string): void {
  console.log(`OK — ${message}`);
}

function fail(message: string): never {
  console.error(`FAIL — ${message}`);
  process.exit(1);
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

async function get(path: string, token: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function login(email: string, password: string): Promise<string> {
  const response = await post('/auth/login', { email, password });
  if (!response.ok) {
    throw new Error(`Login failed for ${email}: ${response.status}`);
  }
  return ((await response.json()) as { accessToken: string }).accessToken;
}

async function registerPatient(label: string): Promise<string> {
  const email = `waiting-list.demo.${label}.${Date.now()}@clinic.test`;
  const password = 'waiting-list-demo-password';

  const response = await post('/auth/register', {
    firstName: 'WaitingList',
    lastName: label,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForConfirmedAppointment(
  token: string,
  startAt: string,
): Promise<AppointmentRow | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const response = await get('/appointments/me', token);
    if (response.ok) {
      const rows = (await response.json()) as AppointmentRow[];
      const match = rows.find(
        (row) => row.status === 'CONFIRMED' && row.startAt === startAt,
      );
      if (match) {
        return match;
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return null;
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

  console.log(`Waiting list demo against ${BASE_URL}`);

  const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

  const doctorEmail = `waiting-list.demo.doctor.${Date.now()}@clinic.test`;
  const doctorPassword = 'waiting-list-demo-password';
  const doctorResponse = await post(
    '/doctors',
    {
      firstName: 'WaitingList',
      lastName: 'Doctor',
      email: doctorEmail,
      password: doctorPassword,
      specialization: 'General Practice',
    },
    adminToken,
  );
  const doctorBody = await requireOk(doctorResponse, 'Create doctor');
  const doctorId = doctorBody.id as string;
  const doctorToken = await login(doctorEmail, doctorPassword);

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

  const patientAToken = await registerPatient('PatientA');
  const patientBToken = await registerPatient('PatientB');

  step(1, 'Patient A books the slot');
  const bookResponse = await post(
    '/appointments',
    { doctorId, startAt },
    patientAToken,
  );
  const booked = (await requireOk(
    bookResponse,
    'Patient A booking',
  )) as unknown as AppointmentRow;
  pass(
    `Patient A holds appointment ${booked.id} at ${booked.startAt} (${local.toFormat('cccc HH:mm')} ${CLINIC_TZ})`,
  );

  step(2, 'Patient B tries the same slot and is told it is taken');
  const conflictResponse = await post(
    '/appointments',
    { doctorId, startAt },
    patientBToken,
  );
  const conflictBody = (await conflictResponse.json()) as {
    code?: string;
    waitingListAvailable?: boolean;
  };
  if (conflictResponse.status !== 409) {
    fail(`expected 409, got ${conflictResponse.status}`);
  }
  if (conflictBody.code !== 'SLOT_ALREADY_BOOKED') {
    fail(`expected SLOT_ALREADY_BOOKED, got ${conflictBody.code ?? 'none'}`);
  }
  if (conflictBody.waitingListAvailable !== true) {
    fail('expected waitingListAvailable: true on the conflict response');
  }
  pass('Patient B received 409 SLOT_ALREADY_BOOKED with waitingListAvailable');

  step(3, 'Patient B joins the waiting list');
  const joinResponse = await post(
    '/waiting-list',
    { doctorId, slotStartAt: startAt },
    patientBToken,
  );
  const joinBody = (await requireOk(
    joinResponse,
    'Join waiting list',
  )) as unknown as WaitingListEntryRow;
  if (joinBody.status !== 'WAITING') {
    fail(`expected WAITING status, got ${joinBody.status}`);
  }
  if (joinBody.position !== 1) {
    fail(`expected queue position 1, got ${joinBody.position}`);
  }
  pass(
    `Patient B is on the waiting list (entry ${joinBody.id}, position ${joinBody.position})`,
  );

  step(4, 'Patient A cancels the appointment');
  const cancelResponse = await post(
    `/appointments/${booked.id}/cancel`,
    {},
    patientAToken,
  );
  const cancelled = (await requireOk(
    cancelResponse,
    'Cancel appointment',
  )) as { status: string };
  if (cancelled.status !== 'CANCELLED') {
    fail(`expected CANCELLED, got ${cancelled.status}`);
  }
  pass(`Appointment ${booked.id} is now CANCELLED; waiting-list job enqueued`);

  step(
    5,
    'Background worker assigns the slot to Patient B (polling GET /appointments/me)',
  );
  const assigned = await waitForConfirmedAppointment(patientBToken, startAt);
  if (!assigned) {
    fail(
      `Patient B did not receive a CONFIRMED appointment within ${POLL_TIMEOUT_MS}ms`,
    );
  }
  pass(`Patient B now holds appointment ${assigned.id} at ${assigned.startAt}`);

  step(6, 'Verify created_from and notifications in PostgreSQL');
  const dataSource = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    synchronize: false,
  });
  await dataSource.initialize();

  const [appointmentRow] = (await dataSource.query(
    `SELECT id, patient_id, created_from, status, start_at
       FROM appointments
      WHERE id = $1`,
    [assigned.id],
  )) as Array<{
    id: string;
    patient_id: string;
    created_from: string;
    status: string;
    start_at: Date;
  }>;

  const notifications = (await dataSource.query(
    `SELECT type, status
       FROM notifications
      WHERE appointment_id = $1
      ORDER BY type`,
    [assigned.id],
  )) as Array<{ type: string; status: string }>;

  await dataSource.destroy();

  console.log('\n--- Final database state ---');
  console.log(JSON.stringify({ appointment: appointmentRow, notifications }, null, 2));

  if (appointmentRow.created_from !== 'WAITING_LIST') {
    fail(`expected created_from WAITING_LIST, got ${appointmentRow.created_from}`);
  }
  if (appointmentRow.status !== 'CONFIRMED') {
    fail(`expected CONFIRMED, got ${appointmentRow.status}`);
  }

  const expectedNotifications = [
    { type: 'REMINDER', status: 'PENDING' },
    { type: 'WAITLIST_ASSIGNED', status: 'PENDING' },
  ];
  if (JSON.stringify(notifications) !== JSON.stringify(expectedNotifications)) {
    fail(`unexpected notifications: ${JSON.stringify(notifications)}`);
  }

  console.log('\nPASSED: waiting list end-to-end demo completed successfully.');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
