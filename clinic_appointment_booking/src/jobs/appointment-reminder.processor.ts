import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { Appointment } from '../appointments/appointment.entity';
import { AppointmentStatus } from '../common/enums/appointment-status.enum';
import { NotificationType } from '../common/enums/notification-type.enum';
import { NotificationsRepository } from '../notifications/notifications.repository';
import { QUEUE_REMINDERS, SendReminderJobData } from './queue.constants';

@Processor(QUEUE_REMINDERS, { concurrency: 5 })
export class AppointmentReminderProcessor extends WorkerHost {
  private readonly logger = new Logger(AppointmentReminderProcessor.name);

  constructor(
    @InjectRepository(Appointment)
    private readonly appointments: Repository<Appointment>,
    private readonly notifications: NotificationsRepository,
  ) {
    super();
  }

  async process(job: Job<SendReminderJobData>): Promise<void> {
    const { appointmentId } = job.data;

    // Step 1: re-derive from the database. The payload carries an id only, so
    // a retry hours later still acts on current state.
    const appointment = await this.appointments.findOne({
      where: { id: appointmentId },
    });

    // Step 2: a cancelled (or deleted) appointment sends nothing. This — not
    // removing the BullMQ job — is what guarantees it.
    if (!appointment || appointment.status !== AppointmentStatus.Confirmed) {
      this.logger.log(
        `Reminder skipped: appointment ${appointmentId} is not CONFIRMED`,
      );
      return;
    }

    // Step 3: claim the send with one conditional update. Zero rows means
    // another worker already sent it, or there is nothing to send.
    const claimed = await this.notifications.markSentIfPending(
      appointmentId,
      NotificationType.Reminder,
    );

    if (!claimed) {
      this.logger.log(
        `Reminder for appointment ${appointmentId} was already sent; nothing to do`,
      );
      return;
    }

    // Step 4: "send" it. The task requires no real email or SMS; the
    // notifications row is what makes the behaviour observable.
    this.logger.log(
      `REMINDER sent: appointment ${appointmentId} for patient ` +
        `${appointment.patientId} starts at ${appointment.startAt.toISOString()}`,
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<SendReminderJobData>, error: Error): void {
    this.logger.error(
      `Reminder job ${job.id} failed on attempt ${job.attemptsMade}: ${error.message}`,
    );
  }
}
