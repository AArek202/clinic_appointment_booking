import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Clock } from '../common/clock/clock';
import {
  JOB_PROCESS_SLOT,
  JOB_SEND_REMINDER,
  ProcessSlotJobData,
  QUEUE_REMINDERS,
  QUEUE_WAITING_LIST,
  SendReminderJobData,
  processSlotJobId,
  sendReminderJobId,
  sweepReminderJobId,
  sweepWaitlistJobId,
} from './queue.constants';

/**
 * The only place in the codebase that enqueues a job.
 *
 * Every caller must already have committed its transaction. PostgreSQL and
 * Redis cannot commit together, so enqueueing inside a transaction would let a
 * worker read pre-commit state; see docs/INFRASTRUCTURE/BackgroundJobs.md.
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    @InjectQueue(QUEUE_REMINDERS)
    private readonly reminders: Queue<SendReminderJobData>,
    @InjectQueue(QUEUE_WAITING_LIST)
    private readonly waitingList: Queue<ProcessSlotJobData>,
    private readonly clock: Clock,
  ) {}

  /** Call after the booking transaction commits. */
  async scheduleReminder(
    appointmentId: string,
    scheduledAt: Date,
  ): Promise<void> {
    // An appointment booked less than REMINDER_LEAD_HOURS out has a
    // scheduled_at in the past. It still gets a reminder; it just fires now.
    const delay = Math.max(
      0,
      scheduledAt.getTime() - this.clock.now().getTime(),
    );

    await this.reminders.add(
      JOB_SEND_REMINDER,
      { appointmentId },
      delay > 0
        ? { jobId: sendReminderJobId(appointmentId), delay }
        : { jobId: sendReminderJobId(appointmentId) },
    );
  }

  /**
   * Best-effort tidying of the delayed set after a cancellation.
   *
   * Never the guarantee that a cancelled appointment sends no reminder — the
   * worker re-checks appointment status at execution time. Removal can fail
   * because the job is already active, or because Redis is unavailable, and
   * neither may fail the cancellation that just committed.
   */
  async removeReminder(appointmentId: string): Promise<void> {
    try {
      await this.reminders.remove(sendReminderJobId(appointmentId));
    } catch (error) {
      this.logger.warn(
        `Could not remove reminder job for appointment ${appointmentId}: ` +
          `${(error as Error).message}. The worker will skip it on status re-check.`,
      );
    }
  }

  /** Used by the reconciliation sweeper for a reminder whose job was lost. */
  async enqueueDueReminder(appointmentId: string, now: Date): Promise<void> {
    await this.reminders.add(
      JOB_SEND_REMINDER,
      { appointmentId },
      { jobId: sweepReminderJobId(appointmentId, now) },
    );
  }

  /** Call after the cancellation transaction commits. */
  async enqueueSlotProcessing(
    doctorId: string,
    slotStartAt: Date,
  ): Promise<void> {
    await this.waitingList.add(
      JOB_PROCESS_SLOT,
      { doctorId, slotStartAtIso: slotStartAt.toISOString() },
      { jobId: processSlotJobId(doctorId, slotStartAt) },
    );
  }

  /** Used by the reconciliation sweeper for a slot whose job was lost or already completed. */
  async enqueueStrandedSlotProcessing(
    doctorId: string,
    slotStartAt: Date,
    now: Date,
  ): Promise<void> {
    await this.waitingList.add(
      JOB_PROCESS_SLOT,
      { doctorId, slotStartAtIso: slotStartAt.toISOString() },
      { jobId: sweepWaitlistJobId(doctorId, slotStartAt, now) },
    );
  }
}
