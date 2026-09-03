import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSchedules1756900000000 implements MigrationInterface {
  name = 'CreateSchedules1756900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE schedules (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        doctor_id uuid NOT NULL REFERENCES doctors (id) ON DELETE CASCADE,
        day_of_week smallint NOT NULL,
        start_time time NOT NULL,
        end_time time NOT NULL,
        slot_duration_minutes smallint NOT NULL,
        CONSTRAINT schedules_day_of_week_valid CHECK (day_of_week BETWEEN 0 AND 6),
        CONSTRAINT schedules_time_valid CHECK (start_time < end_time),
        CONSTRAINT schedules_slot_duration_valid CHECK (slot_duration_minutes IN (15, 30, 60))
      )
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN schedules.day_of_week IS
        '0 = Sunday .. 6 = Saturday, matching PostgreSQL EXTRACT(DOW FROM date). The analytics capacity query joins schedules to generated dates with s.day_of_week = EXTRACT(DOW FROM d.day), so an ISO convention (1 = Monday) would shift every schedule by one day while still looking internally consistent. Do not change this without changing that query.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE schedules`);
  }
}
