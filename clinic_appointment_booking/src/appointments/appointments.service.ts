import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { AuthUser } from '../auth/auth-user.interface';
import { resolveSlot } from '../availability/slot-generator';
import { BlocksRepository } from '../blocks/blocks.repository';
import { Clock } from '../common/clock/clock';
import { CANCELLATION_WINDOW_HOURS } from '../common/constants';
import { AppointmentSource } from '../common/enums/appointment-source.enum';
import { AppointmentStatus } from '../common/enums/appointment-status.enum';
import { UserRole } from '../common/enums/role.enum';
import {
  AppException,
  BadRequestError,
  ConflictError,
} from '../common/errors/app.exception';
import {
  isConstraintViolation,
  isDeadlock,
} from '../common/errors/database-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { JobsService } from '../jobs/jobs.service';
import { SchedulesRepository } from '../schedules/schedules.repository';
import { Appointment } from './appointment.entity';
import { AppointmentsRepository } from './appointments.repository';

const DOCTOR_OVERLAP = 'appointments_no_overlap';
const PATIENT_OVERLAP = 'appointments_patient_no_overlap';

// Concurrent inserts into a GiST exclusion index can deadlock (40P01) before
// either statement finishes with 23P01. Postgres aborts one transaction; the
// documented response is to retry. After the winner commits, the retry hits
// the constraint and maps to 409. Mapping 40P01 itself to "slot booked" would
// be wrong: a deadlock can also happen between writes that do not overlap.
const INSERT_DEADLOCK_ATTEMPTS = 8;

function deadlockBackoffMs(attempt: number): number {
  const baseMs = 25 * 2 ** (attempt - 1);
  const jitterMs = Math.floor(Math.random() * 25);
  return Math.min(baseMs + jitterMs, 400);
}

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly appointments: AppointmentsRepository,
    private readonly schedules: SchedulesRepository,
    private readonly blocks: BlocksRepository,
    private readonly clock: Clock,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly jobs: JobsService,
  ) {}

  async book(
    patientId: string,
    doctorId: string,
    startAt: Date,
  ): Promise<Appointment> {
    const timeZone = this.config.getOrThrow<string>('CLINIC_TZ');

    if (startAt.getTime() <= this.clock.now().getTime()) {
      throw new BadRequestError(
        ErrorCode.SlotNotOnGrid,
        'Appointments can only be booked in the future.',
      );
    }

    // Layer 1: snap the request to the doctor's slot grid and derive endAt.
    // Everything downstream, including availability listing and analytics,
    // assumes rows sit on a predictable grid.
    const windows = await this.schedules.findByDoctorId(doctorId);
    const slot = resolveSlot(startAt, windows, timeZone);
    if (!slot) {
      throw new BadRequestError(
        ErrorCode.SlotNotOnGrid,
        "The requested time is not one of this doctor's available slots.",
      );
    }

    // findOverlapping returns an array. Check its length -- an empty array is
    // truthy, so `if (blocking)` would reject every booking as blocked.
    const blocking = await this.blocks.findOverlapping(
      doctorId,
      slot.startAt,
      slot.endAt,
    );
    if (blocking.length > 0) {
      throw new ConflictError(
        ErrorCode.SlotBlocked,
        'The doctor is unavailable at this time.',
      );
    }

    const patientConflict = await this.appointments.findOverlappingForPatient(
      patientId,
      slot.startAt,
      slot.endAt,
    );
    if (patientConflict) {
      throw new ConflictError(
        ErrorCode.PatientAlreadyBooked,
        'You already have an appointment at this time.',
      );
    }

    for (let attempt = 1; attempt <= INSERT_DEADLOCK_ATTEMPTS; attempt++) {
      try {
        const appointment = await this.dataSource.transaction(
          async (manager) => {
            const created = await this.appointments.insertConfirmed(
              {
                doctorId,
                patientId,
                startAt: slot.startAt,
                endAt: slot.endAt,
                createdFrom: AppointmentSource.Direct,
              },
              manager,
            );

            // PLAN 6 INTEGRATION POINT: create the PENDING REMINDER notification
            // row here, inside this transaction, with
            // scheduledAt = startAt - REMINDER_LEAD_HOURS.
            return created;
          },
        );

        // PLAN 6 INTEGRATION POINT: after the transaction commits, enqueue the
        // delayed reminder job. Never inside the transaction.
        return appointment;
      } catch (error) {
        // Layer 2: the database is the final authority. Both constraints raise
        // 23P01, so branch on the name -- one means the slot is gone, the other
        // means this patient is busy elsewhere.
        if (isConstraintViolation(error, DOCTOR_OVERLAP)) {
          throw new ConflictError(
            ErrorCode.SlotAlreadyBooked,
            'This slot has just been booked by another patient.',
            { waitingListAvailable: true },
          );
        }

        if (isConstraintViolation(error, PATIENT_OVERLAP)) {
          throw new ConflictError(
            ErrorCode.PatientAlreadyBooked,
            'You already have an appointment at this time.',
          );
        }

        if (isDeadlock(error) && attempt < INSERT_DEADLOCK_ATTEMPTS) {
          await new Promise((resolve) =>
            setTimeout(resolve, deadlockBackoffMs(attempt)),
          );
          continue;
        }

        // Anything else is a real fault and must not be reported as a conflict.
        throw error;
      }
    }

    throw new Error('Booking insert retry loop exited without a result');
  }

  /**
   * Creates a CONFIRMED appointment from the waiting list, inside a caller's
   * transaction. Rethrows the raw error so the caller can branch on the
   * constraint name and decide whether to stop or try the next candidate.
   */
  createFromWaitingList(
    manager: EntityManager,
    params: { doctorId: string; patientId: string; startAt: Date; endAt: Date },
  ): Promise<Appointment> {
    return this.appointments.insertConfirmed(
      { ...params, createdFrom: AppointmentSource.WaitingList },
      manager,
    );
  }

  async cancel(appointmentId: string, actor: AuthUser): Promise<Appointment> {
    const appointment = await this.appointments.findById(appointmentId);
    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    const isOwner = actor.patientId === appointment.patientId;
    if (actor.role !== UserRole.Admin && !isOwner) {
      throw new AppException(
        ErrorCode.NotAppointmentOwner,
        'You can only cancel your own appointments.',
        HttpStatus.FORBIDDEN,
      );
    }

    if (appointment.status === AppointmentStatus.Cancelled) {
      // Idempotent: a retried request returns current state, not an error.
      return appointment;
    }

    const hoursUntil =
      (appointment.startAt.getTime() - this.clock.now().getTime()) /
      (60 * 60 * 1000);
    if (hoursUntil < CANCELLATION_WINDOW_HOURS) {
      throw new ConflictError(
        ErrorCode.CancellationWindowPassed,
        `Appointments cannot be cancelled less than ${CANCELLATION_WINDOW_HOURS} hours in advance.`,
      );
    }

    const affected = await this.appointments.cancelIfConfirmed(
      appointmentId,
      this.clock.now(),
    );

    if (affected === 0) {
      // Someone cancelled it between our read and our write. Not an error.
      const current = await this.appointments.findById(appointmentId);
      return current!;
    }

    // After the cancellation has committed. Never inside the transaction:
    // a worker could otherwise start before the commit lands, read a still
    // CONFIRMED appointment, correctly do nothing, and the slot would never
    // be reassigned.
    await this.jobs.removeReminder(appointment.id);
    await this.jobs.enqueueSlotProcessing(
      appointment.doctorId,
      appointment.startAt,
    );

    const updated = await this.appointments.findById(appointmentId);
    return updated!;
  }

  listForPatient(patientId: string): Promise<Appointment[]> {
    return this.appointments.listForPatient(patientId);
  }

  async listForDoctor(doctorId: string): Promise<Appointment[]> {
    if (!(await this.schedules.doctorExists(doctorId))) {
      throw new AppException(
        ErrorCode.NotFound,
        'Doctor not found',
        HttpStatus.NOT_FOUND,
      );
    }

    return this.appointments.listForDoctor(doctorId);
  }
}
