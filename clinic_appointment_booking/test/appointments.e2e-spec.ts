import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Clock, FixedClock } from '../src/common/clock/clock';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import {
  createJwtService,
  seedAdmin,
  seedDoctor,
  seedPatient,
  truncateAll,
} from './helpers/seed.helper';

// Fixture: two doctors with a Monday 10:00-16:00, 30-minute schedule.
// CLINIC_TZ is Africa/Cairo; October is UTC+3, so 10:00 local is 07:00Z.
// 2026-10-05 is a Monday.

const SLOT_START = '2026-10-05T07:00:00.000Z';
const NEXT_SLOT_START = '2026-10-05T07:30:00.000Z';
const NOW_BEFORE_SLOT = new Date('2026-10-05T06:00:00.000Z');
const NOW_AFTER_SLOT = new Date('2026-10-06T12:00:00.000Z');

describe('Appointments API (booking)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let clock: FixedClock;
  let adminToken: string;
  let doctorId: string;
  let doctorToken: string;
  let secondDoctorId: string;
  let secondDoctorToken: string;
  let patientId: string;
  let patientToken: string;
  let otherPatientToken: string;

  beforeAll(async () => {
    clock = new FixedClock(NOW_BEFORE_SLOT);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    clock.set(NOW_BEFORE_SLOT);
    await truncateAll(dataSource);

    const jwt = createJwtService();
    const admin = await seedAdmin(dataSource, jwt);
    const doctor = await seedDoctor(dataSource, jwt);
    const secondDoctor = await seedDoctor(dataSource, jwt);
    const patient = await seedPatient(dataSource, jwt);
    const otherPatient = await seedPatient(dataSource, jwt);

    adminToken = admin.token;
    doctorId = doctor.doctorId!;
    doctorToken = doctor.token;
    secondDoctorId = secondDoctor.doctorId!;
    secondDoctorToken = secondDoctor.token;
    patientId = patient.patientId!;
    patientToken = patient.token;
    otherPatientToken = otherPatient.token;

    await addMondaySchedule(doctorId);
    await addMondaySchedule(secondDoctorId);
  });

  async function addMondaySchedule(targetDoctorId: string): Promise<void> {
    await request(app.getHttpServer())
      .post(`/doctors/${targetDoctorId}/schedules`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        dayOfWeek: 1,
        startTime: '10:00',
        endTime: '16:00',
        slotDurationMinutes: 30,
      })
      .expect(201);
  }

  async function createBlock(
    targetDoctorId: string,
    startAt: string,
    endAt: string,
  ): Promise<void> {
    await request(app.getHttpServer())
      .post(`/doctors/${targetDoctorId}/blocks`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ startAt, endAt })
      .expect(201);
  }

  async function bookAs(
    token: string,
    targetDoctorId: string,
    startAt: string,
  ) {
    const response = await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${token}`)
      .send({ doctorId: targetDoctorId, startAt })
      .expect(201);

    return response.body as { id: string };
  }

  async function cancelAs(
    token: string,
    appointmentId: string,
  ): Promise<{ cancelledAt: string | null }> {
    const response = await request(app.getHttpServer())
      .post(`/appointments/${appointmentId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    return response.body as { cancelledAt: string | null };
  }

  it('books an available slot on the grid', async () => {
    const response = await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ doctorId, startAt: SLOT_START })
      .expect(201);

    expect(response.body).toEqual({
      id: expect.any(String),
      doctorId,
      startAt: SLOT_START,
      endAt: NEXT_SLOT_START,
      status: 'CONFIRMED',
      createdFrom: 'DIRECT',
    });
  });

  it('derives endAt from the schedule and ignores a client-supplied endAt', async () => {
    await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({
        doctorId,
        startAt: SLOT_START,
        endAt: '2026-10-05T07:05:00.000Z',
      })
      .expect(400);
  });

  it('rejects a slot that is not on the grid', async () => {
    const response = await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ doctorId, startAt: '2026-10-05T07:07:00.000Z' })
      .expect(400);

    expect(response.body.code).toBe('SLOT_NOT_ON_GRID');
  });

  it('rejects a slot outside the working schedule', async () => {
    const response = await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ doctorId, startAt: '2026-10-05T20:00:00.000Z' })
      .expect(400);

    expect(response.body.code).toBe('SLOT_NOT_ON_GRID');
  });

  it('rejects a slot covered by a block', async () => {
    await createBlock(doctorId, '2026-10-05T07:00:00Z', '2026-10-05T08:00:00Z');

    const response = await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ doctorId, startAt: SLOT_START })
      .expect(409);

    expect(response.body.code).toBe('SLOT_BLOCKED');
  });

  it('rejects a second booking of the same slot with SLOT_ALREADY_BOOKED', async () => {
    await bookAs(patientToken, doctorId, SLOT_START);

    const response = await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${otherPatientToken}`)
      .send({ doctorId, startAt: SLOT_START })
      .expect(409);

    expect(response.body.code).toBe('SLOT_ALREADY_BOOKED');
    expect(response.body.waitingListAvailable).toBe(true);
  });

  it('rejects a patient booking two overlapping slots with different doctors', async () => {
    await bookAs(patientToken, doctorId, SLOT_START);

    const response = await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ doctorId: secondDoctorId, startAt: SLOT_START })
      .expect(409);

    expect(response.body.code).toBe('PATIENT_ALREADY_BOOKED');
  });

  it('allows rebooking a slot after it was cancelled', async () => {
    // 09:00Z is 3 hours ahead of the fixed clock, so HTTP cancel is allowed.
    const slot = '2026-10-05T09:00:00.000Z';
    const first = await bookAs(patientToken, doctorId, slot);
    await cancelAs(patientToken, first.id);

    await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${otherPatientToken}`)
      .send({ doctorId, startAt: slot })
      .expect(201);
  });

  it('allows back-to-back appointments', async () => {
    await bookAs(patientToken, doctorId, SLOT_START);

    await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${otherPatientToken}`)
      .send({ doctorId, startAt: NEXT_SLOT_START })
      .expect(201);
  });

  it('rejects booking a slot in the past', async () => {
    clock.set(NOW_AFTER_SLOT);

    const response = await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ doctorId, startAt: SLOT_START })
      .expect(400);

    expect(response.body.code).toBe('SLOT_NOT_ON_GRID');
  });

  describe('cancellation', () => {
    it('cancels an appointment more than 2 hours ahead', async () => {
      // now = 06:00Z, appointment at 09:00Z -> 3 hours ahead
      const appointment = await bookAs(
        patientToken,
        doctorId,
        '2026-10-05T09:00:00.000Z',
      );

      const response = await request(app.getHttpServer())
        .post(`/appointments/${appointment.id}/cancel`)
        .set('Authorization', `Bearer ${patientToken}`)
        .expect(200);

      expect(response.body.status).toBe('CANCELLED');
      expect(response.body.cancelledAt).not.toBeNull();
    });

    it('rejects cancelling less than 2 hours ahead', async () => {
      // now = 06:00Z, appointment at 07:30Z -> 1.5 hours ahead
      const appointment = await bookAs(
        patientToken,
        doctorId,
        '2026-10-05T07:30:00.000Z',
      );

      const response = await request(app.getHttpServer())
        .post(`/appointments/${appointment.id}/cancel`)
        .set('Authorization', `Bearer ${patientToken}`)
        .expect(409);

      expect(response.body.code).toBe('CANCELLATION_WINDOW_PASSED');
    });

    it('allows cancelling at exactly 2 hours ahead', async () => {
      // now = 06:00Z, appointment at 08:00Z -> exactly 2 hours
      const appointment = await bookAs(
        patientToken,
        doctorId,
        '2026-10-05T08:00:00.000Z',
      );

      await request(app.getHttpServer())
        .post(`/appointments/${appointment.id}/cancel`)
        .set('Authorization', `Bearer ${patientToken}`)
        .expect(200);
    });

    it("rejects cancelling another patient's appointment", async () => {
      const appointment = await bookAs(
        patientToken,
        doctorId,
        '2026-10-05T09:00:00.000Z',
      );

      const response = await request(app.getHttpServer())
        .post(`/appointments/${appointment.id}/cancel`)
        .set('Authorization', `Bearer ${otherPatientToken}`)
        .expect(403);

      expect(response.body.code).toBe('NOT_APPOINTMENT_OWNER');
    });

    it('treats a repeated cancel as success and does not cancel twice', async () => {
      const appointment = await bookAs(
        patientToken,
        doctorId,
        '2026-10-05T09:00:00.000Z',
      );

      const first = await request(app.getHttpServer())
        .post(`/appointments/${appointment.id}/cancel`)
        .set('Authorization', `Bearer ${patientToken}`)
        .expect(200);

      const second = await request(app.getHttpServer())
        .post(`/appointments/${appointment.id}/cancel`)
        .set('Authorization', `Bearer ${patientToken}`)
        .expect(200);

      expect(second.body.cancelledAt).toBe(first.body.cancelledAt);
    });

    it('returns 404 for an unknown appointment', async () => {
      await request(app.getHttpServer())
        .post('/appointments/00000000-0000-0000-0000-000000000000/cancel')
        .set('Authorization', `Bearer ${patientToken}`)
        .expect(404);
    });
  });

  describe('GET /doctors/:doctorId/appointments', () => {
    it('returns the owning doctor their calendar, including patientId', async () => {
      const booked = await bookAs(patientToken, doctorId, SLOT_START);

      const response = await request(app.getHttpServer())
        .get(`/doctors/${doctorId}/appointments`)
        .set('Authorization', `Bearer ${doctorToken}`)
        .expect(200);

      expect(response.body).toEqual([
        {
          id: booked.id,
          doctorId,
          patientId,
          startAt: SLOT_START,
          endAt: NEXT_SLOT_START,
          status: 'CONFIRMED',
          createdFrom: 'DIRECT',
        },
      ]);
    });

    it('returns the same list to an admin', async () => {
      await bookAs(patientToken, doctorId, SLOT_START);

      const response = await request(app.getHttpServer())
        .get(`/doctors/${doctorId}/appointments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].patientId).toBe(patientId);
    });

    it('includes cancelled rows so the doctor still has history', async () => {
      const appointment = await bookAs(
        patientToken,
        doctorId,
        '2026-10-05T09:00:00.000Z',
      );
      await cancelAs(patientToken, appointment.id);

      const response = await request(app.getHttpServer())
        .get(`/doctors/${doctorId}/appointments`)
        .set('Authorization', `Bearer ${doctorToken}`)
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].status).toBe('CANCELLED');
    });

    it('rejects a different doctor with 403', async () => {
      const response = await request(app.getHttpServer())
        .get(`/doctors/${doctorId}/appointments`)
        .set('Authorization', `Bearer ${secondDoctorToken}`)
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
    });

    it('rejects a patient with 403', async () => {
      await request(app.getHttpServer())
        .get(`/doctors/${doctorId}/appointments`)
        .set('Authorization', `Bearer ${patientToken}`)
        .expect(403);
    });

    it('returns 404 for a doctor that does not exist', async () => {
      const response = await request(app.getHttpServer())
        .get('/doctors/00000000-0000-4000-8000-000000000000/appointments')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
    });
  });
});
