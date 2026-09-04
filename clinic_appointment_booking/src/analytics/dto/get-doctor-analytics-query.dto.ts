import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class GetDoctorAnalyticsQueryDto {
  /**
   * Query-string values arrive as strings and the global ValidationPipe is
   * configured with `transform: true` but not `enableImplicitConversion`, so
   * the @Type decorator is what makes @IsInt meaningful here.
   */
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;
}
