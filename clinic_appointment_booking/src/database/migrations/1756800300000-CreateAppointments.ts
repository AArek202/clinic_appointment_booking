import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAppointments1756800300000 implements MigrationInterface {
  name = 'CreateAppointments1756800300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE appointments (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        doctor_id    uuid NOT NULL REFERENCES doctors (id) ON DELETE RESTRICT,
        patient_id   uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
        start_at     timestamptz NOT NULL,
        end_at       timestamptz NOT NULL,
        status       text NOT NULL,
        created_from text NOT NULL DEFAULT 'DIRECT',
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now(),
        cancelled_at timestamptz,
        CONSTRAINT appointments_time_valid CHECK (end_at > start_at),
        CONSTRAINT appointments_status_valid
          CHECK (status IN ('CONFIRMED', 'CANCELLED')),
        CONSTRAINT appointments_created_from_valid
          CHECK (created_from IN ('DIRECT', 'WAITING_LIST'))
      )
    `);

    // The booking invariant. Two CONFIRMED appointments for one doctor may
    // never overlap in time. Stated as overlap, not equal start time: slot
    // duration lives per schedule row and may change without rewriting
    // history, so a 30-minute appointment at 10:00 can coexist with a new
    // 15-minute booking at 10:15 -- distinct start times, real overlap.
    // '[)' is half-open so back-to-back slots do not collide.
    // Partial, so cancelled rows do not block rebooking.
    await queryRunner.query(`
      ALTER TABLE appointments
        ADD CONSTRAINT appointments_no_overlap
        EXCLUDE USING gist (
          doctor_id WITH =,
          tstzrange(start_at, end_at, '[)') WITH &&
        ) WHERE (status = 'CONFIRMED')
    `);

    // A patient cannot attend two appointments at once either.
    await queryRunner.query(`
      ALTER TABLE appointments
        ADD CONSTRAINT appointments_patient_no_overlap
        EXCLUDE USING gist (
          patient_id WITH =,
          tstzrange(start_at, end_at, '[)') WITH &&
        ) WHERE (status = 'CONFIRMED')
    `);

    // "List my appointments" and the ownership check on cancel.
    await queryRunner.query(`
      CREATE INDEX appointments_patient_start_idx
        ON appointments (patient_id, start_at)
    `);

    // Monthly analytics, which must count CANCELLED rows and therefore
    // cannot use the partial exclusion index.
    await queryRunner.query(`
      CREATE INDEX appointments_doctor_start_idx
        ON appointments (doctor_id, start_at)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE appointments`);
  }
}
