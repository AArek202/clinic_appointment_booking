import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUsersDoctorsPatients1756800100000 implements MigrationInterface {
  name = 'CreateUsersDoctorsPatients1756800100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE users (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        first_name    text NOT NULL,
        last_name     text NOT NULL,
        email         text NOT NULL,
        password_hash text NOT NULL,
        role          text NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT users_email_unique UNIQUE (email),
        CONSTRAINT users_role_valid CHECK (role IN ('ADMIN', 'DOCTOR', 'PATIENT'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE doctors (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id        uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        specialization text NOT NULL,
        achievements   text,
        CONSTRAINT doctors_user_id_unique UNIQUE (user_id)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE patients (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id        uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        phone_number   text,
        date_of_birth  date,
        gender         text,
        has_insurance  boolean NOT NULL DEFAULT false,
        CONSTRAINT patients_user_id_unique UNIQUE (user_id)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE patients`);
    await queryRunner.query(`DROP TABLE doctors`);
    await queryRunner.query(`DROP TABLE users`);
  }
}
