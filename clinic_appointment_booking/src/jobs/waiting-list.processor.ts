import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DataSource, EntityManager } from 'typeorm';
import { AppointmentsService } from '../appointments/appointments.service';
import { REMINDER_LEAD_HOURS } from '../common/constants';
import { Clock } from '../common/clock/clock';
import { NotificationType } from '../common/enums/notification-type.enum';
import { isConstraintViolation } from '../common/errors/database-error';
import { NotificationsRepository } from '../notifications/notifications.repository';
import { WaitingListRepository } from '../waiting-list/waiting-list.repository';
import {
  JOB_PROCESS_SLOT,
  ProcessSlotJobData,
  QUEUE_WAITING_LIST,
  WAITING_LIST_CANDIDATE_LIMIT,
} from './queue.constants';

const DOCTOR_OVERLAP = 'appointments_no_overlap';
const PATIENT_OVERLAP = 'appointments_patient_no_overlap';

@Processor(QUEUE_WAITING_LIST)
export class WaitingListProcessor extends WorkerHost {
  private readonly logger = new Logger(WaitingListProcessor.name);

  constructor(
    private readonly entries: WaitingListRepository,
    private readonly appointments: AppointmentsService,
    private readonly notifications: NotificationsRepository,
    private readonly clock: Clock,
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  async process(job: Job<ProcessSlotJobData>): Promise<void> {
    if (job.name !== JOB_PROCESS_SLOT) {
      return;
    }

    const { doctorId, slotStartAtIso } = job.data;
    const slotStartAt = new Date(slotStartAtIso);

    // Everything is re-derived from the database. The payload carries only
    // identifiers, so a retry always acts on current state.
    await this.dataSource.transaction(async (manager) => {
      const assigned = await this.assign(manager, doctorId, slotStartAt);

      if (!assigned) {
        this.logger.log(
          `No assignment for doctor ${doctorId} at ${slotStartAtIso}: ` +
            'slot taken, queue empty, or no eligible candidate.',
        );
      }
    });
  }

  private async assign(
    manager: EntityManager,
    doctorId: string,
    slotStartAt: Date,
  ): Promise<boolean> {
    const now = this.clock.now();

    const candidates = await this.entries.findCandidates(
      manager,
      doctorId,
      slotStartAt,
      WAITING_LIST_CANDIDATE_LIMIT,
      now,
    );

    for (const candidate of candidates) {
      // An error aborts a PostgreSQL transaction, so each attempt gets its
      // own savepoint. Without this, the first ineligible candidate would
      // destroy the whole transaction and no one would get the slot.
      await manager.query('SAVEPOINT candidate_attempt');

      try {
        const appointment = await this.appointments.createFromWaitingList(
          manager,
          {
            doctorId,
            patientId: candidate.patientId,
            startAt: candidate.slotStartAt,
            endAt: candidate.slotEndAt,
          },
        );

        const claimed = await this.entries.markAssigned(manager, candidate.id);
        if (!claimed) {
          // Another worker took this entry between our lock and our update.
          await manager.query('ROLLBACK TO SAVEPOINT candidate_attempt');
          continue;
        }

        const reminderAt = new Date(
          appointment.startAt.getTime() - REMINDER_LEAD_HOURS * 60 * 60 * 1000,
        );

        await this.notifications.createPending(manager, {
          appointmentId: appointment.id,
          patientId: candidate.patientId,
          type: NotificationType.Reminder,
          scheduledAt: reminderAt,
        });

        await this.notifications.createPending(manager, {
          appointmentId: appointment.id,
          patientId: candidate.patientId,
          type: NotificationType.WaitlistAssigned,
          scheduledAt: now,
        });

        await manager.query('RELEASE SAVEPOINT candidate_attempt');

        this.logger.log(
          `Assigned slot ${slotStartAt.toISOString()} for doctor ${doctorId} ` +
            `to patient ${candidate.patientId} (appointment ${appointment.id}).`,
        );
        return true;
      } catch (error) {
        await manager.query('ROLLBACK TO SAVEPOINT candidate_attempt');

        // The doctor's slot is gone -- a direct booking won the race. No
        // retry can help, and the queue stays intact for a future opening.
        if (isConstraintViolation(error, DOCTOR_OVERLAP)) {
          this.logger.log(
            `Slot ${slotStartAt.toISOString()} for doctor ${doctorId} was taken ` +
              'by a direct booking. Nothing to assign.',
          );
          return false;
        }

        // This candidate is busy elsewhere, but the slot is still free.
        // Leave them WAITING and try the next one.
        if (isConstraintViolation(error, PATIENT_OVERLAP)) {
          this.logger.log(
            `Patient ${candidate.patientId} is unavailable at ` +
              `${slotStartAt.toISOString()}. Trying the next candidate.`,
          );
          continue;
        }

        throw error;
      }
    }

    return false;
  }
}
