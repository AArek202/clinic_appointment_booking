import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ALLOWED_SLOT_DURATIONS } from '../../common/constants';
import { TIME_OF_DAY_PATTERN } from '../time-of-day';

/**
 * Every field optional: PATCH is a partial update. The fields are repeated
 * rather than derived with PartialType, which lives in @nestjs/mapped-types and
 * is not a dependency of this project. Four repeated fields are cheaper than a
 * new package.
 */
export class UpdateScheduleDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek?: number;

  @IsOptional()
  @IsString()
  @Matches(TIME_OF_DAY_PATTERN, {
    message:
      'startTime must be a 24-hour time of day, for example 10:00 or 10:00:00',
  })
  startTime?: string;

  @IsOptional()
  @IsString()
  @Matches(TIME_OF_DAY_PATTERN, {
    message:
      'endTime must be a 24-hour time of day, for example 16:00 or 16:00:00',
  })
  endTime?: string;

  @IsOptional()
  @IsIn([...ALLOWED_SLOT_DURATIONS])
  slotDurationMinutes?: number;
}
