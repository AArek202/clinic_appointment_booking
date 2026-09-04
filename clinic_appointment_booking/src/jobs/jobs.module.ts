import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobsService } from './jobs.service';
import {
  QUEUE_MAINTENANCE,
  QUEUE_REMINDERS,
  QUEUE_WAITING_LIST,
} from './queue.constants';

/**
 * Redis connection and queue registration.
 *
 * Registering a queue creates a producer only — no worker. That is why both the
 * API and the worker process can import this module, while only the worker
 * imports ProcessorsModule. See docs/DECISIONS.md #13.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: { url: config.getOrThrow<string>('REDIS_URL') },
      }),
    }),
    BullModule.registerQueue(
      {
        name: QUEUE_REMINDERS,
        defaultJobOptions: {
          // A reminder that fails is worth retrying for a while: the usual
          // cause is a transient database or Redis blip, and re-running is
          // safe because markSentIfPending only ever succeeds once.
          attempts: 5,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { age: 3_600, count: 1_000 },
          // Failed jobs are kept for a day so an exhausted retry chain is
          // visible instead of vanishing.
          removeOnFail: { age: 86_400 },
        },
      },
      {
        name: QUEUE_WAITING_LIST,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: { age: 3_600, count: 1_000 },
          removeOnFail: { age: 86_400 },
        },
      },
      {
        name: QUEUE_MAINTENANCE,
        defaultJobOptions: {
          // The sweeper runs again in 60 seconds regardless, so long retry
          // chains would only pile up overlapping passes.
          attempts: 3,
          backoff: { type: 'fixed', delay: 5_000 },
          removeOnComplete: { count: 20 },
          removeOnFail: { count: 50 },
        },
      },
    ),
  ],
  providers: [JobsService],
  exports: [BullModule, JobsService],
})
export class JobsModule {}
