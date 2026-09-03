import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

export interface SeededSlot {
  doctorId: string;
  patientId: string;
  appointmentId: string;
  startAt: Date;
  endAt: Date;
}

/**
 * A DataSource pointed at the test database.
 *
 * `test/setup-db.ts` rewrites DATABASE_URL to TEST_DATABASE_URL in Jest's
 * globalSetup, which runs before the workers fork, so process.env here is
 * already the test database.
 */
export function createTestDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    entities: ['src/**/*.entity.ts'],
    synchronize: false,
  });
}

/**
 * Empties every table the job tests write to.
 *
 * Order does not matter because of CASCADE, and CASCADE also covers tables
 * added by later plans (waiting_list) without editing this list.
 */
export async function resetJobTables(dataSource: DataSource): Promise<void> {
  await dataSource.query(
    'TRUNCATE notifications, appointments, patients, doctors, users CASCADE',
  );
}

async function insertUser(
  dataSource: DataSource,
  role: string,
): Promise<string> {
  const [row]: Array<{ id: string }> = await dataSource.query(
    `INSERT INTO users (first_name, last_name, email, password_hash, role, created_at, updated_at)
     VALUES ($1, $2, $3, 'not-a-real-hash', $4, now(), now())
     RETURNING id`,
    ['Test', role, `${role.toLowerCase()}-${randomUUID()}@example.test`, role],
  );
  return row.id;
}

export async function seedPatient(dataSource: DataSource): Promise<string> {
  const userId = await insertUser(dataSource, 'PATIENT');
  const [row]: Array<{ id: string }> = await dataSource.query(
    `INSERT INTO patients (user_id, has_insurance) VALUES ($1, false) RETURNING id`,
    [userId],
  );
  return row.id;
}

export async function seedDoctor(dataSource: DataSource): Promise<string> {
  const userId = await insertUser(dataSource, 'DOCTOR');
  const [row]: Array<{ id: string }> = await dataSource.query(
    `INSERT INTO doctors (user_id, specialization) VALUES ($1, 'General') RETURNING id`,
    [userId],
  );
  return row.id;
}

/** A CONFIRMED, DIRECT appointment plus the doctor and patient it needs. */
export async function seedConfirmedAppointment(
  dataSource: DataSource,
  params: { startAt: Date; endAt: Date },
): Promise<SeededSlot> {
  const doctorId = await seedDoctor(dataSource);
  const patientId = await seedPatient(dataSource);

  const [row]: Array<{ id: string }> = await dataSource.query(
    `INSERT INTO appointments
       (doctor_id, patient_id, start_at, end_at, status, created_from, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'CONFIRMED', 'DIRECT', now(), now())
     RETURNING id`,
    [doctorId, patientId, params.startAt, params.endAt],
  );

  return {
    doctorId,
    patientId,
    appointmentId: row.id,
    startAt: params.startAt,
    endAt: params.endAt,
  };
}

export async function cancelAppointment(
  dataSource: DataSource,
  appointmentId: string,
): Promise<void> {
  await dataSource.query(
    `UPDATE appointments SET status = 'CANCELLED', cancelled_at = now(), updated_at = now()
      WHERE id = $1`,
    [appointmentId],
  );
}

export async function insertPendingReminder(
  dataSource: DataSource,
  params: { appointmentId: string; patientId: string; scheduledAt: Date },
): Promise<string> {
  const [row]: Array<{ id: string }> = await dataSource.query(
    `INSERT INTO notifications (appointment_id, patient_id, type, status, scheduled_at)
     VALUES ($1, $2, 'REMINDER', 'PENDING', $3)
     RETURNING id`,
    [params.appointmentId, params.patientId, params.scheduledAt],
  );
  return row.id;
}
