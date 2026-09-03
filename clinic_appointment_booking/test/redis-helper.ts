import Redis from 'ioredis';

export const DEFAULT_TEST_REDIS_URL = 'redis://localhost:6379/1';

/**
 * Refuses to touch Redis database 0.
 *
 * `docker compose up` puts real delayed reminder jobs in database 0. The
 * integration suite flushes whatever it is pointed at, so pointing it at 0
 * would delete every scheduled reminder on the developer's machine.
 */
export function assertIsolatedRedis(url: string): void {
  const database = new URL(url).pathname.replace('/', '');

  if (database === '' || database === '0') {
    throw new Error(
      `Refusing to run the integration suite against Redis database 0 (${url}). ` +
        `Set TEST_REDIS_URL to a dedicated index, for example ${DEFAULT_TEST_REDIS_URL}`,
    );
  }
}

/** Empties the test Redis database. Call in beforeEach of any queue test. */
export async function flushTestRedis(): Promise<void> {
  const url = process.env.REDIS_URL;

  if (!url) {
    throw new Error(
      'REDIS_URL is not set; test/setup-db.ts should have set it',
    );
  }

  assertIsolatedRedis(url);

  const client = new Redis(url, { maxRetriesPerRequest: null });
  try {
    await client.flushdb();
  } finally {
    await client.quit();
  }
}

/**
 * Polls until the predicate is true.
 *
 * Queue tests cannot assert immediately after enqueueing: a real worker in
 * another event-loop turn has to pick the job up first.
 */
export async function waitFor(
  predicate: () => Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const { timeoutMs = 10_000, intervalMs = 50 } = options;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for the condition`);
}
