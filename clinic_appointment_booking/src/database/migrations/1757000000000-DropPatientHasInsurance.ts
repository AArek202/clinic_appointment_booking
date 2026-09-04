import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropPatientHasInsurance1757000000000 implements MigrationInterface {
  name = 'DropPatientHasInsurance1757000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE patients DROP COLUMN has_insurance`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE patients ADD COLUMN has_insurance boolean NOT NULL DEFAULT false`,
    );
  }
}
