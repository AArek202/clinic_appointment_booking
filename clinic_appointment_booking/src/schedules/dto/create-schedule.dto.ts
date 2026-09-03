import { IsIn, IsInt, IsString, Matches, Max, Min } from 'class-validator';
import { ALLOWED_SLOT_DURATIONS } from '../../common/constants';
import { TIME_OF_DAY_PATTERN } from '../time-of-day';

export class CreateScheduleDto {
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek: number;

  @IsString()
  @Matches(TIME_OF_DAY_PATTERN, {
    message:
      'startTime must be a 24-hour time of day, for example 10:00 or 10:00:00',
  })
  startTime: string;

  @IsString()
  @Matches(TIME_OF_DAY_PATTERN, {
    message:
      'endTime must be a 24-hour time of day, for example 16:00 or 16:00:00',
  })
  endTime: string;

  // Spread because ALLOWED_SLOT_DURATIONS is a readonly tuple and @IsIn wants a
  // mutable array. The single source of the allowed values stays in constants.
  @IsIn([...ALLOWED_SLOT_DURATIONS])
  slotDurationMinutes: number;
}
