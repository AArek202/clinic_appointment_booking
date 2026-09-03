import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DateTime } from 'luxon';
import { BadRequestError } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-code.enum';
import { AvailabilityRepository } from './availability.repository';
import {
  generateSlots,
  MAX_AVAILABILITY_RANGE_DAYS,
  Slot,
} from './slot-generator';

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly repository: AvailabilityRepository,
    private readonly config: ConfigService,
  ) {}

  async listSlots(
    doctorId: string,
    fromDate: string,
    toDate: string,
  ): Promise<Slot[]> {
    const timeZone = this.config.getOrThrow<string>('CLINIC_TZ');

    const first = DateTime.fromISO(fromDate, { zone: timeZone }).startOf('day');
    const last = DateTime.fromISO(toDate, { zone: timeZone }).startOf('day');

    if (!first.isValid || !last.isValid) {
      throw new BadRequestError(
        ErrorCode.ValidationFailed,
        'from and to must be valid calendar dates.',
      );
    }

    if (last < first) {
      throw new BadRequestError(
        ErrorCode.ValidationFailed,
        'to must not precede from.',
      );
    }

    // Inclusive on both ends, so a single day is a range of 1.
    const days = last.diff(first, 'days').days + 1;
    if (days > MAX_AVAILABILITY_RANGE_DAYS) {
      throw new BadRequestError(
        ErrorCode.DateRangeTooLarge,
        `Availability can be listed for at most ${MAX_AVAILABILITY_RANGE_DAYS} days at a time.`,
      );
    }

    if (!(await this.repository.doctorExists(doctorId))) {
      throw new NotFoundException('Doctor not found');
    }

    // The window handed to the range queries must cover the whole local range
    // in UTC, including the exclusive end of the final day.
    const fromAt = first.toUTC().toJSDate();
    const toAt = last.plus({ days: 1 }).toUTC().toJSDate();

    const [schedules, blocks, booked] = await Promise.all([
      this.repository.findScheduleWindows(doctorId),
      this.repository.findBlockedRanges(doctorId, fromAt, toAt),
      this.repository.findBookedRanges(doctorId, fromAt, toAt),
    ]);

    return generateSlots({
      fromDate,
      toDate,
      timeZone,
      schedules,
      blocks,
      booked,
    });
  }
}
