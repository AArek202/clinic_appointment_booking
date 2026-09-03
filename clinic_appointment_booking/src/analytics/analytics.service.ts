import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-code.enum';
import { AnalyticsRepository } from './analytics.repository';
import { DoctorMonthlyAnalytics } from './doctor-monthly-analytics.interface';

@Injectable()
export class AnalyticsService {
  constructor(private readonly repository: AnalyticsRepository) {}

  /**
   * There is deliberately no computation here. Every metric is produced by
   * PostgreSQL; this method exists to turn a missing doctor into a 404 and to
   * keep the controller out of the repository.
   */
  async getDoctorMonthlyAnalytics(
    doctorId: string,
    year: number,
    month: number,
  ): Promise<DoctorMonthlyAnalytics> {
    const exists = await this.repository.doctorExists(doctorId);

    if (!exists) {
      throw new AppException(
        ErrorCode.NotFound,
        'Doctor not found',
        HttpStatus.NOT_FOUND,
      );
    }

    return this.repository.getDoctorMonthlyAnalytics(doctorId, year, month);
  }
}
