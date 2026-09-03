import { Matches } from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class AvailabilityQueryDto {
  /** Clinic-local calendar date, inclusive. */
  @Matches(ISO_DATE, { message: 'from must be a date in YYYY-MM-DD form' })
  from!: string;

  @Matches(ISO_DATE, { message: 'to must be a date in YYYY-MM-DD form' })
  to!: string;
}
