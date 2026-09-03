import { ConfigService } from '@nestjs/config';
import { DataSource, QueryFailedError } from 'typeorm';
import { BlocksRepository } from '../blocks/blocks.repository';
import { FixedClock } from '../common/clock/clock';
import { AppointmentSource } from '../common/enums/appointment-source.enum';
import { AppointmentStatus } from '../common/enums/appointment-status.enum';
import { ConflictError } from '../common/errors/app.exception';
import {
  PG_DEADLOCK_DETECTED,
  PG_EXCLUSION_VIOLATION,
} from '../common/errors/database-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { SchedulesRepository } from '../schedules/schedules.repository';
import { Appointment } from './appointment.entity';
import { AppointmentsRepository } from './appointments.repository';
import { AppointmentsService } from './appointments.service';

const DOCTOR_ID = '11111111-1111-1111-1111-111111111111';
const PATIENT_ID = '22222222-2222-2222-2222-222222222222';
const SLOT_START = new Date('2026-10-05T07:00:00.000Z');

function pgError(code: string, constraint?: string): QueryFailedError {
  const driverError = Object.assign(new Error('database error'), {
    code,
    ...(constraint ? { constraint } : {}),
  });
  return new QueryFailedError('INSERT ...', [], driverError);
}

function appointmentRow(): Appointment {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    doctorId: DOCTOR_ID,
    patientId: PATIENT_ID,
    startAt: SLOT_START,
    endAt: new Date('2026-10-05T07:30:00.000Z'),
    status: AppointmentStatus.Confirmed,
    createdFrom: AppointmentSource.Direct,
    createdAt: SLOT_START,
    updatedAt: SLOT_START,
    cancelledAt: null,
  };
}

function makeService(transaction: jest.Mock) {
  const appointments = {
    findOverlappingForPatient: jest.fn().mockResolvedValue(null),
    insertConfirmed: jest.fn(),
  };
  const schedules = {
    findByDoctorId: jest.fn().mockResolvedValue([
      {
        dayOfWeek: 1,
        startTime: '10:00:00',
        endTime: '16:00:00',
        slotDurationMinutes: 30,
      },
    ]),
  };
  const blocks = {
    findOverlapping: jest.fn().mockResolvedValue([]),
  };
  const clock = new FixedClock(new Date('2026-10-05T06:00:00.000Z'));
  const config = {
    getOrThrow: jest.fn().mockReturnValue('Africa/Cairo'),
  };
  const dataSource = { transaction };

  const service = new AppointmentsService(
    appointments as unknown as AppointmentsRepository,
    schedules as unknown as SchedulesRepository,
    blocks as unknown as BlocksRepository,
    clock,
    config as unknown as ConfigService,
    dataSource as unknown as DataSource,
  );

  return { service, transaction };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected the call to be rejected, but it resolved');
    },
    (error: unknown) => error,
  );
}

describe('AppointmentsService.book deadlock retry', () => {
  it('retries a deadlock and then maps appointments_no_overlap to SLOT_ALREADY_BOOKED', async () => {
    const transaction = jest
      .fn()
      .mockRejectedValueOnce(pgError(PG_DEADLOCK_DETECTED))
      .mockRejectedValueOnce(
        pgError(PG_EXCLUSION_VIOLATION, 'appointments_no_overlap'),
      );
    const { service } = makeService(transaction);

    const error = await rejection(
      service.book(PATIENT_ID, DOCTOR_ID, SLOT_START),
    );

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe(ErrorCode.SlotAlreadyBooked);
    expect((error as ConflictError).extra).toEqual({
      waitingListAvailable: true,
    });
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('retries a deadlock and returns the row when the second insert succeeds', async () => {
    const created = appointmentRow();
    const transaction = jest
      .fn()
      .mockRejectedValueOnce(pgError(PG_DEADLOCK_DETECTED))
      .mockResolvedValueOnce(created);
    const { service } = makeService(transaction);

    await expect(service.book(PATIENT_ID, DOCTOR_ID, SLOT_START)).resolves.toBe(
      created,
    );
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('does not map a deadlock to a booking conflict after retries are exhausted', async () => {
    const deadlock = pgError(PG_DEADLOCK_DETECTED);
    const transaction = jest.fn().mockRejectedValue(deadlock);
    const { service } = makeService(transaction);

    const error = await rejection(
      service.book(PATIENT_ID, DOCTOR_ID, SLOT_START),
    );

    expect(error).toBe(deadlock);
    expect(transaction).toHaveBeenCalledTimes(8);
  });
});
