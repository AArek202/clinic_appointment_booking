import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Clock, FixedClock } from '../src/common/clock/clock';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import {
  cancelConfirmedAppointment,
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
  let secondDoctorId: string;
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
    secondDoctorId = secondDoctor.doctorId!;
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
    _token: string,
    appointmentId: string,
  ): Promise<void> {
    await cancelConfirmedAppointment(dataSource, appointmentId);
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
    const first = await bookAs(patientToken, doctorId, SLOT_START);
    await cancelAs(patientToken, first.id);

    await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${otherPatientToken}`)
      .send({ doctorId, startAt: SLOT_START })
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
});
