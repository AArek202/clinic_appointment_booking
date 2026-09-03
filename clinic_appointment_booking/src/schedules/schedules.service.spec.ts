import { NotFoundException } from '@nestjs/common';
import { BadRequestError, ConflictError } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-code.enum';
import { Schedule } from './schedule.entity';
import { NewSchedule, SchedulesRepository } from './schedules.repository';
import { SchedulesService } from './schedules.service';

const DOCTOR_ID = '11111111-1111-1111-1111-111111111111';

function scheduleRow(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    doctorId: DOCTOR_ID,
    dayOfWeek: 0,
    startTime: '10:00:00',
    endTime: '12:00:00',
    slotDurationMinutes: 30,
    ...overrides,
  };
}

function makeService() {
  const repository = {
    doctorExists: jest.fn().mockResolvedValue(true),
    findByDoctorId: jest.fn().mockResolvedValue([]),
    findByDoctorAndDay: jest.fn().mockResolvedValue([]),
    findByIdForDoctor: jest.fn().mockResolvedValue(null),
    insert: jest.fn((params: NewSchedule) => Promise.resolve(scheduleRow(params))),
    update: jest.fn((schedule: Schedule) => Promise.resolve(schedule)),
    deleteById: jest.fn().mockResolvedValue(undefined),
  };

  const service = new SchedulesService(repository as unknown as SchedulesRepository);

  return { repository, service };
}

/** Returns the rejection value instead of throwing, so it can be asserted on. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected the call to be rejected, but it resolved');
    },
    (error: unknown) => error,
  );
}

describe('SchedulesService.listForDoctor', () => {
  it('throws NotFoundException when the doctor does not exist', async () => {
    const { repository, service } = makeService();
    repository.doctorExists.mockResolvedValue(false);

    const error = await rejection(service.listForDoctor(DOCTOR_ID));

    expect(error).toBeInstanceOf(NotFoundException);
  });
});

describe('SchedulesService.create', () => {
  it('throws NotFoundException when the doctor does not exist', async () => {
    const { repository, service } = makeService();
    repository.doctorExists.mockResolvedValue(false);

    const error = await rejection(
      service.create(DOCTOR_ID, {
        dayOfWeek: 0,
        startTime: '10:00',
        endTime: '12:00',
        slotDurationMinutes: 30,
      }),
    );

    expect(error).toBeInstanceOf(NotFoundException);
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('rejects a window whose start is not before its end', async () => {
    const { service } = makeService();

    const error = await rejection(
      service.create(DOCTOR_ID, {
        dayOfWeek: 0,
        startTime: '16:00',
        endTime: '10:00',
        slotDurationMinutes: 30,
      }),
    );

    expect(error).toBeInstanceOf(BadRequestError);
    expect((error as BadRequestError).code).toBe(ErrorCode.ValidationFailed);
  });

  it('rejects a window that overlaps an existing row on the same weekday', async () => {
    const { repository, service } = makeService();
    repository.findByDoctorAndDay.mockResolvedValue([scheduleRow()]);

    const error = await rejection(
      service.create(DOCTOR_ID, {
        dayOfWeek: 0,
        startTime: '11:00',
        endTime: '13:00',
        slotDurationMinutes: 30,
      }),
    );

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe(ErrorCode.ScheduleOverlap);
    expect((error as ConflictError).extra).toEqual({
      conflictingScheduleId: '22222222-2222-2222-2222-222222222222',
    });
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('accepts a window that is adjacent to an existing row', async () => {
    const { repository, service } = makeService();
    repository.findByDoctorAndDay.mockResolvedValue([scheduleRow()]);

    await service.create(DOCTOR_ID, {
      dayOfWeek: 0,
      startTime: '12:00',
      endTime: '16:00',
      slotDurationMinutes: 15,
    });

    expect(repository.insert).toHaveBeenCalledWith({
      doctorId: DOCTOR_ID,
      dayOfWeek: 0,
      startTime: '12:00:00',
      endTime: '16:00:00',
      slotDurationMinutes: 15,
    });
  });

  it('accepts the same window on a different weekday', async () => {
    const { repository, service } = makeService();
    repository.findByDoctorAndDay.mockResolvedValue([]);

    await service.create(DOCTOR_ID, {
      dayOfWeek: 1,
      startTime: '10:00',
      endTime: '12:00',
      slotDurationMinutes: 30,
    });

    expect(repository.findByDoctorAndDay).toHaveBeenCalledWith(DOCTOR_ID, 1);
    expect(repository.insert).toHaveBeenCalled();
  });

  it('normalises HH:mm input to HH:mm:ss before persisting', async () => {
    const { repository, service } = makeService();

    await service.create(DOCTOR_ID, {
      dayOfWeek: 0,
      startTime: '09:30',
      endTime: '17:00',
      slotDurationMinutes: 60,
    });

    expect(repository.insert).toHaveBeenCalledWith(
      expect.objectContaining({ startTime: '09:30:00', endTime: '17:00:00' }),
    );
  });
});

describe('SchedulesService.update', () => {
  it('throws NotFoundException when the schedule does not belong to that doctor', async () => {
    const { repository, service } = makeService();
    repository.findByIdForDoctor.mockResolvedValue(null);

    const error = await rejection(
      service.update(DOCTOR_ID, '33333333-3333-3333-3333-333333333333', {
        slotDurationMinutes: 15,
      }),
    );

    expect(error).toBeInstanceOf(NotFoundException);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('changes only the slot duration and leaves the window untouched', async () => {
    const { repository, service } = makeService();
    repository.findByIdForDoctor.mockResolvedValue(scheduleRow());

    const updated = await service.update(
      DOCTOR_ID,
      '22222222-2222-2222-2222-222222222222',
      { slotDurationMinutes: 15 },
    );

    expect(updated).toMatchObject({
      dayOfWeek: 0,
      startTime: '10:00:00',
      endTime: '12:00:00',
      slotDurationMinutes: 15,
    });
    expect(repository.update).toHaveBeenCalledTimes(1);
  });

  it('excludes the row being updated from the overlap check', async () => {
    const { repository, service } = makeService();
    const existing = scheduleRow();
    repository.findByIdForDoctor.mockResolvedValue(existing);
    repository.findByDoctorAndDay.mockResolvedValue([existing]);

    const updated = await service.update(
      DOCTOR_ID,
      '22222222-2222-2222-2222-222222222222',
      { endTime: '13:00' },
    );

    expect(updated.endTime).toBe('13:00:00');
  });

  it('rejects a change that would overlap a different row', async () => {
    const { repository, service } = makeService();
    const target = scheduleRow();
    const other = scheduleRow({
      id: '44444444-4444-4444-4444-444444444444',
      startTime: '14:00:00',
      endTime: '16:00:00',
    });
    repository.findByIdForDoctor.mockResolvedValue(target);
    repository.findByDoctorAndDay.mockResolvedValue([target, other]);

    const error = await rejection(
      service.update(DOCTOR_ID, target.id, { endTime: '15:00' }),
    );

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe(ErrorCode.ScheduleOverlap);
    expect((error as ConflictError).extra).toEqual({
      conflictingScheduleId: '44444444-4444-4444-4444-444444444444',
    });
  });
});

describe('SchedulesService.remove', () => {
  it('throws NotFoundException when the schedule does not belong to that doctor', async () => {
    const { repository, service } = makeService();
    repository.findByIdForDoctor.mockResolvedValue(null);

    const error = await rejection(
      service.remove(DOCTOR_ID, '33333333-3333-3333-3333-333333333333'),
    );

    expect(error).toBeInstanceOf(NotFoundException);
    expect(repository.deleteById).not.toHaveBeenCalled();
  });

  it('deletes the row by id', async () => {
    const { repository, service } = makeService();
    repository.findByIdForDoctor.mockResolvedValue(scheduleRow());

    await service.remove(DOCTOR_ID, '22222222-2222-2222-2222-222222222222');

    expect(repository.deleteById).toHaveBeenCalledWith('22222222-2222-2222-2222-222222222222');
  });
});
