import { MigrationInterface, QueryRunner } from 'typeorm';

export class EnableBtreeGist1756800000000 implements MigrationInterface {
  name = 'EnableBtreeGist1756800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Required by the appointment overlap exclusion constraints added later.
    // Created here so the extension exists before any table depends on it.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP EXTENSION IF EXISTS btree_gist`);
  }
}
