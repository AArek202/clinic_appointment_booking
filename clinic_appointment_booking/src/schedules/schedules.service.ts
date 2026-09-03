import { Injectable, NotFoundException } from '@nestjs/common';
import { BadRequestError, ConflictError } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-code.enum';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { findOverlappingWindow, ScheduleTimeWindow } from './schedule-overlap';
import { Schedule } from './schedule.entity';
import { SchedulesRepository } from './schedules.repository';
import { normalizeTimeOfDay, timeOfDayToSeconds } from './time-of-day';

@Injectable()
export class SchedulesService {
  constructor(private readonly repository: SchedulesRepository) {}

  async listForDoctor(doctorId: string): Promise<Schedule[]> {
    await this.assertDoctorExists(doctorId);

    return this.repository.findByDoctorId(doctorId);
  }

  async create(doctorId: string, dto: CreateScheduleDto): Promise<Schedule> {
    await this.assertDoctorExists(doctorId);

    const window: ScheduleTimeWindow = {
      dayOfWeek: dto.dayOfWeek,
      startTime: normalizeTimeOfDay(dto.startTime),
      endTime: normalizeTimeOfDay(dto.endTime),
    };

    this.assertStartBeforeEnd(window);
    await this.assertNoOverlap(doctorId, window, null);

    return this.repository.insert({
      doctorId,
      dayOfWeek: window.dayOfWeek,
      startTime: window.startTime,
      endTime: window.endTime,
      slotDurationMinutes: dto.slotDurationMinutes,
    });
  }

  async update(
    doctorId: string,
    scheduleId: string,
    dto: UpdateScheduleDto,
  ): Promise<Schedule> {
    const schedule = await this.findOwnedOrFail(doctorId, scheduleId);

    // A PATCH sends only the fields it changes, so the unsent ones are read
    // back off the stored row and re-validated together with the new ones.
    const window: ScheduleTimeWindow = {
      dayOfWeek: dto.dayOfWeek ?? schedule.dayOfWeek,
      startTime: normalizeTimeOfDay(dto.startTime ?? schedule.startTime),
      endTime: normalizeTimeOfDay(dto.endTime ?? schedule.endTime),
    };

    this.assertStartBeforeEnd(window);
    await this.assertNoOverlap(doctorId, window, schedule.id);

    schedule.dayOfWeek = window.dayOfWeek;
    schedule.startTime = window.startTime;
    schedule.endTime = window.endTime;
    schedule.slotDurationMinutes =
      dto.slotDurationMinutes ?? schedule.slotDurationMinutes;

    // Only this schedules row is written. Appointments already booked keep
    // their own start_at and end_at, so moving a doctor from 30-minute to
    // 15-minute slots never rewrites history. See docs/FEATURES/Schedules.md
    // and docs/INFRASTRUCTURE/Concurrency.md, which is why booking is protected
    // by an overlap exclusion constraint rather than a unique start_at index.
    return this.repository.update(schedule);
  }

  async remove(doctorId: string, scheduleId: string): Promise<void> {
    const schedule = await this.findOwnedOrFail(doctorId, scheduleId);

    // A hard delete. Removing a schedule stops new bookings from being
    // generated for that window; it does not cancel appointments already made,
    // for the same reason a duration change does not rewrite them.
    await this.repository.deleteById(schedule.id);
  }

  private async assertDoctorExists(doctorId: string): Promise<void> {
    if (!(await this.repository.doctorExists(doctorId))) {
      throw new NotFoundException('Doctor not found');
    }
  }

  private async findOwnedOrFail(
    doctorId: string,
    scheduleId: string,
  ): Promise<Schedule> {
    const schedule = await this.repository.findByIdForDoctor(
      scheduleId,
      doctorId,
    );

    if (!schedule) {
      throw new NotFoundException('Schedule not found');
    }

    return schedule;
  }

  private assertStartBeforeEnd(window: ScheduleTimeWindow): void {
    if (
      timeOfDayToSeconds(window.startTime) >= timeOfDayToSeconds(window.endTime)
    ) {
      throw new BadRequestError(
        ErrorCode.ValidationFailed,
        'startTime must be earlier than endTime',
      );
    }
  }

  /**
   * Rejects a window that overlaps another row for the same doctor and weekday.
   *
   * This check is here and not in the database because an EXCLUDE constraint
   * needs a range type over the column type, and PostgreSQL has no built-in
   * range type over `time`. Documented as a known gap in docs/DATABASE.md.
   *
   * `ignoreScheduleId` is the row being edited: a row always overlaps itself.
   */
  private async assertNoOverlap(
    doctorId: string,
    window: ScheduleTimeWindow,
    ignoreScheduleId: string | null,
  ): Promise<void> {
    const sameDay = await this.repository.findByDoctorAndDay(
      doctorId,
      window.dayOfWeek,
    );
    const others = sameDay.filter((row) => row.id !== ignoreScheduleId);
    const conflict = findOverlappingWindow(window, others);

    if (conflict) {
      throw new ConflictError(
        ErrorCode.ScheduleOverlap,
        `This window overlaps an existing schedule (${conflict.startTime}-${conflict.endTime}) on the same day`,
        { conflictingScheduleId: conflict.id },
      );
    }
  }
}
