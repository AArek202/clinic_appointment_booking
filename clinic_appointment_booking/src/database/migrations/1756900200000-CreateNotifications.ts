import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateNotifications1756900200000 implements MigrationInterface {
  name = 'CreateNotifications1756900200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE notifications (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        appointment_id uuid NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
        patient_id     uuid NOT NULL REFERENCES patients (id),
        type           text NOT NULL,
        status         text NOT NULL DEFAULT 'PENDING',
        scheduled_at   timestamptz NOT NULL,
        sent_at        timestamptz,
        created_at     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT notifications_unique_per_type UNIQUE (appointment_id, type),
        CONSTRAINT notifications_type_valid
          CHECK (type IN ('REMINDER', 'WAITLIST_ASSIGNED')),
        CONSTRAINT notifications_status_valid
          CHECK (status IN ('PENDING', 'SENT')),
        CONSTRAINT notifications_sent_at_consistent
          CHECK ((status = 'SENT') = (sent_at IS NOT NULL))
      )
    `);

    await queryRunner.query(`
      COMMENT ON CONSTRAINT notifications_unique_per_type ON notifications IS
        'Idempotency key for background jobs: one notification of each type per appointment, ever.'
    `);

    // The reconciliation sweeper's only query: due-but-unsent notifications.
    // docs/DATABASE.md lists this as (status, scheduled_at); under the partial
    // predicate `status` is a constant, so it is dropped from the key. Same
    // plan, smaller index.
    await queryRunner.query(`
      CREATE INDEX notifications_pending_due_idx
        ON notifications (scheduled_at)
        WHERE status = 'PENDING'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS notifications_pending_due_idx`);
    await queryRunner.query(`DROP TABLE IF EXISTS notifications`);
  }
}
