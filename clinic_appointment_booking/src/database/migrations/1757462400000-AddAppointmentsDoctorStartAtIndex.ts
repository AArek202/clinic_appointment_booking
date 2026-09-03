import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAppointmentsDoctorStartAtIndex1757462400000 implements MigrationInterface {
  name = 'AddAppointmentsDoctorStartAtIndex1757462400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The monthly analytics query counts CANCELLED rows as well as CONFIRMED
    // ones, so it cannot use the partial GiST index that the
    // appointments_no_overlap exclusion constraint creates
    // (WHERE status = 'CONFIRMED'). This non-partial btree serves the
    // (doctor_id, start_at range) scan in the `stats` and `hourly` CTEs.
    //
    // Plan 5 created the same index as appointments_doctor_start_idx; this
    // migration standardises the name used in docs and EXPLAIN evidence.
    //
    // Not CONCURRENTLY: TypeORM runs each migration inside a transaction and
    // CREATE INDEX CONCURRENTLY cannot run in one. On a live production table
    // this index would be created out of band instead.
    await queryRunner.query(
      `DROP INDEX IF EXISTS appointments_doctor_start_idx`,
    );
    await queryRunner.query(
      `CREATE INDEX appointments_doctor_start_at_idx ON appointments (doctor_id, start_at)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX appointments_doctor_start_at_idx`);
    await queryRunner.query(
      `CREATE INDEX appointments_doctor_start_idx ON appointments (doctor_id, start_at)`,
    );
  }
}
