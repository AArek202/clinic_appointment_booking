import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  // createApplicationContext, not create(): the worker listens on no port and
  // must not expose an HTTP surface.
  const app = await NestFactory.createApplicationContext(WorkerModule);

  // On SIGTERM, Nest calls onModuleDestroy on @nestjs/bullmq's providers, which
  // closes the workers. Without this, `docker compose stop` kills the process
  // mid-job; the job would be retried and is safe to retry, but finishing the
  // current one is better than relying on that.
  app.enableShutdownHooks();

  new Logger('Worker').log(
    'Worker started: reminders, waiting-list and maintenance queues',
  );
}

void bootstrap();
