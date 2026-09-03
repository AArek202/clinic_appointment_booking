import { Injectable } from '@nestjs/common';
import { BlocksRepository } from '../blocks/blocks.repository';
import { SchedulesRepository } from '../schedules/schedules.repository';
import { ScheduleWindow, TimeRange } from './slot-generator';

@Injectable()
export class AvailabilityRepository {
  constructor(
    private readonly schedules: SchedulesRepository,
    private readonly blocks: BlocksRepository,
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
   * PLAN 5 INTEGRATION POINT.
   *
   * The appointments table does not exist yet, so nothing is booked. Plan 5
   * Task 6 replaces this body with:
   *
   *   return this.appointments.findBookedRanges(doctorId, fromAt, toAt);
   *
   * and adds AppointmentsModule to AvailabilityModule's imports. The
   * signature must not change.
   */
  async findBookedRanges(
    _doctorId: string,
    _fromAt: Date,
    _toAt: Date,
  ): Promise<TimeRange[]> {
    return [];
  }
}
