import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DOCTOR_MONTHLY_ANALYTICS_SQL } from './analytics.sql';
import { DoctorMonthlyAnalytics } from './doctor-monthly-analytics.interface';

/**
 * Shape of the single row the analytics query returns.
 *
 * `numeric` columns arrive from node-postgres as strings, because a numeric can
 * hold values a JavaScript number cannot. Both percentages are bounded
 * two-decimal values, so Number() is safe here — and it is the only arithmetic
 * this class is allowed to do.
 */
interface AnalyticsRow {
  total_appointments: number;
  cancellation_rate: string;
  peak_hours: number[];
  utilization_rate: string;
}

@Injectable()
export class AnalyticsRepository {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  /**
   * One statement, one round trip, four already-computed scalars.
   *
   * `month` is 1-12. The clinic timezone is a query parameter rather than a
   * service argument because it is part of the query's contract, not a business
   * decision the caller gets to make.
   */
  async getDoctorMonthlyAnalytics(
    doctorId: string,
    year: number,
    month: number,
  ): Promise<DoctorMonthlyAnalytics> {
    const timeZone = this.config.getOrThrow<string>('CLINIC_TZ');

    const rows: AnalyticsRow[] = await this.dataSource.query(
      DOCTOR_MONTHLY_ANALYTICS_SQL,
      [doctorId, year, month, timeZone],
    );

    // The query cross-joins three single-row aggregates, so there is always
    // exactly one row, even when the doctor has no data at all.
    const row = rows[0];

    return {
      totalAppointments: row.total_appointments,
      cancellationRate: Number(row.cancellation_rate),
      peakHours: row.peak_hours,
      utilizationRate: Number(row.utilization_rate),
    };
  }
}
