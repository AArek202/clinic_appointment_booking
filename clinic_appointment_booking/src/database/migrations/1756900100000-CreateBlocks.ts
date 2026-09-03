import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateBlocks1756900100000 implements MigrationInterface {
  name = 'CreateBlocks1756900100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE blocks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        doctor_id uuid NOT NULL REFERENCES doctors (id) ON DELETE CASCADE,
        start_at timestamptz NOT NULL,
        end_at timestamptz NOT NULL,
        reason text,
        CONSTRAINT blocks_time_valid CHECK (end_at > start_at)
      )
    `);

    // One period of unavailability per row per doctor. The bound is half-open,
    // so adjacent blocks are still accepted. btree_gist is created by Plan 1's
    // first migration. See docs/DECISIONS.md #18.
    await queryRunner.query(`
      ALTER TABLE blocks ADD CONSTRAINT blocks_no_overlap
        EXCLUDE USING gist (
          doctor_id WITH =,
          tstzrange(start_at, end_at, '[)') WITH &&
        )
    `);

    // Named query: "which blocked periods does this doctor have that touch the
    // requested date range?", run on every availability request and every
    // booking. docs/DATABASE.md lists this index for exactly that query.
    await queryRunner.query(`
      CREATE INDEX blocks_doctor_id_start_at_end_at_idx
        ON blocks (doctor_id, start_at, end_at)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Dropping the table drops its index, but the explicit statement keeps the
    // down migration a readable mirror of the up migration.
    await queryRunner.query(
      `DROP INDEX IF EXISTS blocks_doctor_id_start_at_end_at_idx`,
    );
    await queryRunner.query(`DROP TABLE blocks`);
  }
}
