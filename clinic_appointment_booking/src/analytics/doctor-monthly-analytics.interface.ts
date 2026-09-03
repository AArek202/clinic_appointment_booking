/**
 * Monthly analytics for one doctor. Every field is computed by PostgreSQL;
 * nothing here is derived in JavaScript.
 *
 * Contract: docs/PLANS/00-interfaces.md, "AnalyticsRepository (Plan 8)".
 */
export interface DoctorMonthlyAnalytics {
  totalAppointments: number;
  /** Percentage, two decimal places. 0 when there are no appointments. */
  cancellationRate: number;
  /** Clinic-local hours, ascending. All tied hours, empty when there is no data. */
  peakHours: number[];
  /** Percentage, two decimal places. 0 when there is no schedule that month. */
  utilizationRate: number;
}
