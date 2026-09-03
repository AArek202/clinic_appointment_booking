import { Injectable } from '@nestjs/common';
import { AppointmentsRepository } from '../appointments/appointments.repository';
import { BlocksRepository } from '../blocks/blocks.repository';
import { SchedulesRepository } from '../schedules/schedules.repository';
import { ScheduleWindow, TimeRange } from './slot-generator';

@Injectable()
export class AvailabilityRepository {
  constructor(
    private readonly schedules: SchedulesRepository,
    private readonly blocks: BlocksRepository,
    private readonly appointments: AppointmentsRepository,
  ) {}

  doctorExists(doctorId: string): Promise<boolean> {
    return this.schedules.doctorExists(doctorId);
  }

  /** Schedule rows structurally satisfy ScheduleWindow, so no mapping. */
  findScheduleWindows(doctorId: string): Promise<ScheduleWindow[]> {
    return this.schedules.findByDoctorId(doctorId);
  }

  async findBlockedRanges(
    doctorId: string,
    fromAt: Date,
    toAt: Date,
  ): Promise<TimeRange[]> {
    const blocks = await this.blocks.findOverlapping(doctorId, fromAt, toAt);
    return blocks.map((block) => ({
      startAt: block.startAt,
      endAt: block.endAt,
    }));
  }

  /**
   * Confirmed appointments overlapping the window. Cancelled rows are excluded
   * by AppointmentsRepository, so a cancelled slot reappears here.
   */
  findBookedRanges(
    doctorId: string,
    fromAt: Date,
    toAt: Date,
  ): Promise<TimeRange[]> {
    return this.appointments.findBookedRanges(doctorId, fromAt, toAt);
  }
}
