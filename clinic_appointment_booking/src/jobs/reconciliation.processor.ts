import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Clock } from '../common/clock/clock';
import { NotificationType } from '../common/enums/notification-type.enum';
import { NotificationsRepository } from '../notifications/notifications.repository';
import { JobsService } from './jobs.service';
import { QUEUE_MAINTENANCE, RECONCILE_BATCH_LIMIT } from './queue.constants';
import { WaitingListReconciler } from './waiting-list-reconciler';

export interface ReconciliationSummary {
  strandedSlotsEnqueued: number;
  dueRemindersEnqueued: number;
  waitingEntriesExpired: number;
}

/**
 * Re-derives pending work from PostgreSQL every RECONCILE_EVERY_MS.
 *
 * This is the recovery path for three things:
 *  - a process that died between COMMIT and queue.add,
 *  - a Redis restart that lost the delayed jobs,
 *  - waiting-list entries that quietly became irrelevant.
 *
 * It queries only, decides nothing on its own, and enqueues jobs that are
 * themselves idempotent — which is what makes it safe to run twice, and safe
 * to run on several worker replicas at once.
 */
@Processor(QUEUE_MAINTENANCE)
export class ReconciliationProcessor extends WorkerHost {
  private readonly logger = new Logger(ReconciliationProcessor.name);

  constructor(
    private readonly notifications: NotificationsRepository,
    private readonly waitingListReconciler: WaitingListReconciler,
    private readonly jobs: JobsService,
    private readonly clock: Clock,
  ) {
    super();
  }

  async process(): Promise<ReconciliationSummary> {
    const now = this.clock.now();

    const summary: ReconciliationSummary = {
      strandedSlotsEnqueued: await this.enqueueStrandedSlots(now),
      dueRemindersEnqueued: await this.enqueueDueReminders(now),
      waitingEntriesExpired: await this.waitingListReconciler.expireStale(now),
    };

    if (
      summary.strandedSlotsEnqueued > 0 ||
      summary.dueRemindersEnqueued > 0 ||
      summary.waitingEntriesExpired > 0
    ) {
      this.logger.log(
        `Reconciliation: ${summary.strandedSlotsEnqueued} stranded slot(s), ` +
          `${summary.dueRemindersEnqueued} due reminder(s), ` +
          `${summary.waitingEntriesExpired} expired waiting entry/entries`,
      );
    }

    return summary;
  }

  /**
   * Pass 1: cancelled appointments whose slot still has WAITING entries.
   * The deterministic slot job id means re-enqueueing an already queued slot
   * is a no-op.
   */
  private async enqueueStrandedSlots(now: Date): Promise<number> {
    const slots = await this.waitingListReconciler.findStrandedSlots(
      now,
      RECONCILE_BATCH_LIMIT,
    );

    for (const slot of slots) {
      await this.jobs.enqueueSlotProcessing(slot.doctorId, slot.slotStartAt);
    }

    return slots.length;
  }

  /**
   * Pass 2: PENDING notifications past scheduled_at whose appointment is still
   * CONFIRMED. Enqueued rather than sent inline, so there is exactly one code
   * path that delivers a reminder.
   */
  private async enqueueDueReminders(now: Date): Promise<number> {
    const due = await this.notifications.findDuePending(
      now,
      RECONCILE_BATCH_LIMIT,
    );

    const reminders = due.filter(
      (row) => row.type === NotificationType.Reminder,
    );
    const others = due.length - reminders.length;

    if (others > 0) {
      // The sweeper knows how to trigger reminders only. A due PENDING
      // WAITLIST_ASSIGNED row means Plan 7's assignment transaction left one
      // behind, which is a bug worth surfacing rather than swallowing.
      this.logger.warn(
        `${others} due notification(s) are of a type this sweeper cannot deliver`,
      );
    }

    for (const reminder of reminders) {
      await this.jobs.enqueueDueReminder(reminder.appointmentId, now);
    }

    return reminders.length;
  }
}
