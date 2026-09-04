import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';
import { DEFAULT_TEST_REDIS_URL, assertIsolatedRedis } from './redis-helper';

loadDotenv();

/**
 * Runs migrations against the test database before the e2e suite.
 *
 * Migrations, not `synchronize: true` — migration correctness is part of what
 * the suite verifies.
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL is required to run the e2e suite');
  }

  process.env.DATABASE_URL = url;

  const redisUrl = process.env.TEST_REDIS_URL ?? DEFAULT_TEST_REDIS_URL;
  assertIsolatedRedis(redisUrl);
  process.env.REDIS_URL = redisUrl;

  const dataSource = new DataSource({
    type: 'postgres',
    url,
    migrations: ['src/database/migrations/*.ts'],
    synchronize: false,
  });

  await dataSource.initialize();
  await dataSource.runMigrations();
  await dataSource.destroy();
}
