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
