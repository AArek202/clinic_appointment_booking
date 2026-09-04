export const QUEUE_REMINDERS = 'reminders';
export const QUEUE_WAITING_LIST = 'waiting-list';
export const QUEUE_MAINTENANCE = 'maintenance';

export const JOB_SEND_REMINDER = 'send-reminder';
export const JOB_PROCESS_SLOT = 'process-slot';
export const JOB_RECONCILE = 'reconcile';

export interface SendReminderJobData {
  appointmentId: string;
}

export interface ProcessSlotJobData {
  doctorId: string;
  slotStartAtIso: string;
}

/** Deterministic id so duplicate enqueues for the same slot collapse into one. */
export function processSlotJobId(doctorId: string, slotStartAt: Date): string {
  return `waitlist:${doctorId}:${slotStartAt.toISOString()}`;
}

export function sendReminderJobId(appointmentId: string): string {
  return `reminder:${appointmentId}`;
}

export const RECONCILE_EVERY_MS = 60_000;
export const WAITING_LIST_CANDIDATE_LIMIT = 10;

/** BullMQ job-scheduler key for the repeatable sweeper. Upserted, so re-registering is safe. */
export const RECONCILE_SCHEDULER_ID = 'reconcile-sweeper';

/** How many due notifications one sweep pass will re-enqueue. */
export const RECONCILE_BATCH_LIMIT = 100;

/**
 * Job id used when the *sweeper* re-enqueues a reminder.
 *
 * Deliberately not sendReminderJobId(): BullMQ ignores `add` for a job id that
 * already exists, and the original id may still be held by a job sitting in the
 * failed set. Bucketing by sweep interval keeps two replicas sweeping the same
 * minute from creating two jobs, while never being permanently blocked.
 * Duplicate *delivery* is prevented by markSentIfPending, not by this id.
 */
export function sweepReminderJobId(appointmentId: string, now: Date): string {
  const bucket = Math.floor(now.getTime() / RECONCILE_EVERY_MS);
  return `reminder-sweep:${appointmentId}:${bucket}`;
}

/**
 * Job id used when the *sweeper* re-enqueues waiting-list processing.
 *
 * Same reason as sweepReminderJobId: cancel uses processSlotJobId(), and
 * BullMQ ignores `add` while that id still sits in the completed or failed
 * set. A second cancellation of the same slot (or a stranded waiter the
 * sweeper is meant to recover) would otherwise be a silent no-op for up to
 * removeOnComplete.age. Bucketing by sweep interval keeps replica sweeps in
 * the same minute from creating two jobs; duplicate assignment is prevented
 * by markAssigned, not by this id.
 */
export function sweepWaitlistJobId(
  doctorId: string,
  slotStartAt: Date,
  now: Date,
): string {
  const bucket = Math.floor(now.getTime() / RECONCILE_EVERY_MS);
  return `waitlist-sweep:${doctorId}:${slotStartAt.toISOString()}:${bucket}`;
}
