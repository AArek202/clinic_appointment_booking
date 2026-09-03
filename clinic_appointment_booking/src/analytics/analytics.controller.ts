import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { DoctorOwnershipGuard } from '../auth/guards/doctor-ownership.guard';
import { AnalyticsService } from './analytics.service';
import { DoctorMonthlyAnalytics } from './doctor-monthly-analytics.interface';
import { GetDoctorAnalyticsQueryDto } from './dto/get-doctor-analytics-query.dto';

/**
 * Nested under the doctor so DoctorOwnershipGuard has an explicit subject to
 * check (docs/DECISIONS.md #11).
 *
 * JwtAuthGuard is global (Plan 2), so only the ownership guard is added here.
 * RolesGuard is not needed: DoctorOwnershipGuard passes for ADMIN or for the
 * addressed doctor, and a PATIENT has no doctorId, so it fails for them.
 */
@Controller('doctors/:doctorId/analytics')
@UseGuards(DoctorOwnershipGuard)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get()
  getMonthly(
    @Param('doctorId', ParseUUIDPipe) doctorId: string,
    @Query() query: GetDoctorAnalyticsQueryDto,
  ): Promise<DoctorMonthlyAnalytics> {
    return this.analyticsService.getDoctorMonthlyAnalytics(
      doctorId,
      query.year,
      query.month,
    );
  }
}
