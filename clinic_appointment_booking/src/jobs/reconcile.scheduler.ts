import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  JOB_RECONCILE,
  QUEUE_MAINTENANCE,
  RECONCILE_EVERY_MS,
  RECONCILE_SCHEDULER_ID,
} from './queue.constants';

/**
 * Registers the repeatable sweeper when the worker boots.
 *
 * upsertJobScheduler is keyed by RECONCILE_SCHEDULER_ID, so N worker replicas
 * calling this on startup produce one scheduler, not N. The sweeper's actions
 * are idempotent anyway, because two replicas can still execute the same
 * scheduled occurrence concurrently. See docs/INFRASTRUCTURE/Deployment.md.
 */
@Injectable()
export class ReconcileScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReconcileScheduler.name);

  constructor(
    @InjectQueue(QUEUE_MAINTENANCE) private readonly maintenance: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.maintenance.upsertJobScheduler(
      RECONCILE_SCHEDULER_ID,
      { every: RECONCILE_EVERY_MS },
      { name: JOB_RECONCILE, data: {} },
    );

    this.logger.log(
      `Reconciliation sweeper scheduled every ${RECONCILE_EVERY_MS}ms`,
    );
  }
}
