import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-code.enum';
import { AnalyticsRepository } from './analytics.repository';
import { AnalyticsService } from './analytics.service';

describe('AnalyticsService', () => {
  const repository = {
    doctorExists: jest.fn(),
    getDoctorMonthlyAnalytics: jest.fn(),
  };
  const service = new AnalyticsService(repository as unknown as AnalyticsRepository);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns the repository result unchanged', async () => {
    const analytics = {
      totalAppointments: 4,
      cancellationRate: 50,
      peakHours: [10],
      utilizationRate: 12.5,
    };
    repository.doctorExists.mockResolvedValue(true);
    repository.getDoctorMonthlyAnalytics.mockResolvedValue(analytics);

    const result = await service.getDoctorMonthlyAnalytics('doctor-1', 2026, 2);

    expect(result).toBe(analytics);
    expect(repository.getDoctorMonthlyAnalytics).toHaveBeenCalledWith('doctor-1', 2026, 2);
  });

  it('throws a 404 with code NOT_FOUND for an unknown doctor', async () => {
    repository.doctorExists.mockResolvedValue(false);

    await expect(service.getDoctorMonthlyAnalytics('nobody', 2026, 2)).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });
    await expect(
      service.getDoctorMonthlyAnalytics('nobody', 2026, 2),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('does not run the analytics query for an unknown doctor', async () => {
    repository.doctorExists.mockResolvedValue(false);

    await expect(service.getDoctorMonthlyAnalytics('nobody', 2026, 2)).rejects.toThrow();

    expect(repository.getDoctorMonthlyAnalytics).not.toHaveBeenCalled();
  });

  it('raises the 404 with HTTP status 404', async () => {
    repository.doctorExists.mockResolvedValue(false);

    try {
      await service.getDoctorMonthlyAnalytics('nobody', 2026, 2);
      throw new Error('expected getDoctorMonthlyAnalytics to throw');
    } catch (error) {
      expect((error as AppException).getStatus()).toBe(HttpStatus.NOT_FOUND);
    }
  });
});
