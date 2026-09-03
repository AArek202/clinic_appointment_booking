import 'reflect-metadata';
import { hash } from 'bcryptjs';
import { UserRole } from '../../common/enums/role.enum';
import { AppDataSource } from '../data-source';

/**
 * Creates the initial ADMIN account. Doctors are created by an admin, so
 * without this there is no way to bootstrap the system.
 * Idempotent: running it twice does not create a second admin.
 */
async function main(): Promise<void> {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required');
  }

  await AppDataSource.initialize();

  try {
    const passwordHash = await hash(password, 10);
    const result = await AppDataSource.query(
      `INSERT INTO users (first_name, last_name, email, password_hash, role)
       VALUES ('Clinic', 'Admin', $1, $2, $3)
       ON CONFLICT ON CONSTRAINT users_email_unique DO NOTHING
       RETURNING id`,
      [email.trim().toLowerCase(), passwordHash, UserRole.Admin],
    );

    console.log(
      result.length > 0
        ? `Created admin ${email}`
        : `Admin ${email} already exists, nothing to do`,
    );
  } finally {
    await AppDataSource.destroy();
  }
}

void main();
