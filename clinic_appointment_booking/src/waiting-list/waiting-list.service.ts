import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolveSlot } from '../availability/slot-generator';
import { AppointmentsRepository } from '../appointments/appointments.repository';
import { Clock } from '../common/clock/clock';
import { WaitingListStatus } from '../common/enums/waiting-list-status.enum';
import {
  AppException,
  BadRequestError,
  ConflictError,
} from '../common/errors/app.exception';
import { isConstraintViolation } from '../common/errors/database-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { SchedulesRepository } from '../schedules/schedules.repository';
import { JoinWaitingListDto } from './dto/join-waiting-list.dto';
import { WaitingListEntry } from './waiting-list-entry.entity';
import { WaitingListRepository } from './waiting-list.repository';

const ONE_ACTIVE = 'waiting_list_one_active';

export interface WaitingListEntryView {
  entry: WaitingListEntry;
  position: number;
}

@Injectable()
export class WaitingListService {
  constructor(
    private readonly entries: WaitingListRepository,
    private readonly schedules: SchedulesRepository,
    private readonly appointments: AppointmentsRepository,
    private readonly clock: Clock,
    private readonly config: ConfigService,
  ) {}

  async join(
    patientId: string,
    dto: JoinWaitingListDto,
  ): Promise<WaitingListEntryView> {
    const timeZone = this.config.getOrThrow<string>('CLINIC_TZ');

    if (dto.slotStartAt.getTime() <= this.clock.now().getTime()) {
      throw new BadRequestError(
        ErrorCode.SlotNotOnGrid,
        'You cannot join the waiting list for a slot in the past.',
      );
    }

    const windows = await this.schedules.findByDoctorId(dto.doctorId);
    const slot = resolveSlot(dto.slotStartAt, windows, timeZone);
    if (!slot) {
      throw new BadRequestError(
        ErrorCode.SlotNotOnGrid,
        "The requested time is not one of this doctor's slots.",
      );
    }

    if (dto.expiresAt && dto.expiresAt.getTime() >= slot.startAt.getTime()) {
      throw new BadRequestError(
        ErrorCode.ValidationFailed,
        'expiresAt must be before the slot start time.',
      );
    }

    // Queueing only makes sense for a slot that is actually taken.
    const [booked] = await this.appointments.findBookedRanges(
      dto.doctorId,
      slot.startAt,
      slot.endAt,
    );
    if (!booked) {
      throw new ConflictError(
        ErrorCode.SlotIsAvailable,
        'This slot is currently available — book it instead of queueing.',
      );
    }

    const ownConflict = await this.appointments.findOverlappingForPatient(
      patientId,
      slot.startAt,
      slot.endAt,
    );
    if (ownConflict) {
      throw new ConflictError(
        ErrorCode.PatientAlreadyBooked,
        'You already have an appointment at this time.',
      );
    }

    try {
      const entry = await this.entries.insertWaiting({
        doctorId: dto.doctorId,
        patientId,
        slotStartAt: slot.startAt,
        slotEndAt: slot.endAt,
        expiresAt: dto.expiresAt ?? null,
      });

      return { entry, position: (await this.entries.countAhead(entry)) + 1 };
    } catch (error) {
      // The index, not a prior SELECT, is what makes this safe under
      // concurrent requests from the same patient.
      if (isConstraintViolation(error, ONE_ACTIVE)) {
        throw new ConflictError(
          ErrorCode.AlreadyInWaitingList,
          'You are already on the waiting list for this slot.',
        );
      }
      throw error;
    }
  }

  async leave(entryId: string, patientId: string): Promise<void> {
    const entry = await this.entries.findById(entryId);
    if (!entry) {
      throw new NotFoundException('Waiting list entry not found');
    }

    if (entry.patientId !== patientId) {
      throw new AppException(
        ErrorCode.Forbidden,
        'You can only leave your own waiting list entries.',
        HttpStatus.FORBIDDEN,
      );
    }

    // Conditional, so a repeated request is a no-op rather than an error.
    await this.entries.markStatus(
      entryId,
      WaitingListStatus.Waiting,
      WaitingListStatus.Cancelled,
    );
  }

  async listForPatient(patientId: string): Promise<WaitingListEntryView[]> {
    const entries = await this.entries.listForPatient(patientId);
    return Promise.all(
      entries.map(async (entry) => ({
        entry,
        position: (await this.entries.countAhead(entry)) + 1,
      })),
    );
  }
}
