import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWaitingList1756800500000 implements MigrationInterface {
  name = 'CreateWaitingList1756800500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE waiting_list (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        doctor_id     uuid NOT NULL REFERENCES doctors (id) ON DELETE RESTRICT,
        patient_id    uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
        slot_start_at timestamptz NOT NULL,
        slot_end_at   timestamptz NOT NULL,
        status        text NOT NULL,
        expires_at    timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT waiting_list_time_valid CHECK (slot_end_at > slot_start_at),
        CONSTRAINT waiting_list_status_valid
          CHECK (status IN ('WAITING', 'ASSIGNED', 'EXPIRED', 'CANCELLED')),
        CONSTRAINT waiting_list_expiry_valid
          CHECK (expires_at IS NULL OR expires_at < slot_start_at)
      )
    `);

    // One active entry per patient per slot. Partial, so a patient whose
    // earlier entry expired or was cancelled can join again.
    // Enforced here rather than by a prior SELECT, which would race.
    await queryRunner.query(`
      CREATE UNIQUE INDEX waiting_list_one_active
        ON waiting_list (doctor_id, patient_id, slot_start_at)
        WHERE status = 'WAITING'
    `);

    // The assignment job finding candidates for a freed slot, and the
    // sweeper scanning for stranded entries.
    await queryRunner.query(`
      CREATE INDEX waiting_list_slot_status_idx
        ON waiting_list (doctor_id, slot_start_at, status)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE waiting_list`);
  }
}
