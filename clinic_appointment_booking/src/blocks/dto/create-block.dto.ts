import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateBlockDto {
  /**
   * Absolute instants, ISO 8601 with an offset, e.g. '2026-09-06T07:00:00Z'.
   *
   * Validated as strings and converted to Date in the service rather than with
   * @Type(() => Date). class-transformer would turn '2026-13-45' into an
   * Invalid Date and hand it to the service, which would then write NaN and
   * fail somewhere far from the cause. @IsISO8601 rejects it at the edge.
   */
  @IsISO8601({ strict: true })
  startAt: string;

  @IsISO8601({ strict: true })
  endAt: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
