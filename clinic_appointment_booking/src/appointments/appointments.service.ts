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
import { isConstraintViolation } from '../common/errors/database-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { SchedulesRepository } from '../schedules/schedules.repository';
import { Appointment } from './appointment.entity';
import { AppointmentsRepository } from './appointments.repository';

const DOCTOR_OVERLAP = 'appointments_no_overlap';
const PATIENT_OVERLAP = 'appointments_patient_no_overlap';

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly appointments: AppointmentsRepository,
    private readonly schedules: SchedulesRepository,
    private readonly blocks: BlocksRepository,
    private readonly clock: Clock,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
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

    try {
      const appointment = await this.dataSource.transaction(async (manager) => {
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
      });

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

      // Anything else is a real fault and must not be reported as a conflict.
      throw error;
    }
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

    // PLAN 6 INTEGRATION POINT: after commit, best-effort remove the delayed
    // reminder job, then enqueue WAITING_LIST_PROCESS for
    // (doctorId, startAt). Never inside the transaction.

    const updated = await this.appointments.findById(appointmentId);
    return updated!;
  }

  listForPatient(patientId: string): Promise<Appointment[]> {
    return this.appointments.listForPatient(patientId);
  }

  listForDoctor(doctorId: string): Promise<Appointment[]> {
    return this.appointments.listForDoctor(doctorId);
  }
}
