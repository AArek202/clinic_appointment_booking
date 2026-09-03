import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import {
  createJwtService,
  SeededActor,
  seedAdmin,
  seedDoctor,
  seedPatient,
  truncateAll,
} from './helpers/seed.helper';

// Fixture: a doctor with a Monday 10:00-12:00, 30-minute schedule,
// created through the API as an admin. CLINIC_TZ is Africa/Cairo in .env,
// where October is UTC+3, so 10:00 local is 07:00Z.

describe('Availability API', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let admin: SeededActor;
  let doctor: SeededActor;
  let patient: SeededActor;
  let doctorId: string;
  let patientToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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
    await truncateAll(dataSource);

    const jwt = createJwtService();
    admin = await seedAdmin(dataSource, jwt);
    doctor = await seedDoctor(dataSource, jwt);
    patient = await seedPatient(dataSource, jwt);
    doctorId = doctor.doctorId!;
    patientToken = patient.token;

    await request(app.getHttpServer())
      .post(`/doctors/${doctorId}/schedules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        dayOfWeek: 1,
        startTime: '10:00',
        endTime: '12:00',
        slotDurationMinutes: 30,
      })
      .expect(201);
  });

  async function createBlock(
    targetDoctorId: string,
    startAt: string,
    endAt: string,
  ): Promise<void> {
    await request(app.getHttpServer())
      .post(`/doctors/${targetDoctorId}/blocks`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ startAt, endAt })
      .expect(201);
  }

  async function listAvailability(
    targetDoctorId: string,
    from: string,
    to: string,
  ): Promise<Array<{ startAt: string }>> {
    const response = await request(app.getHttpServer())
      .get(`/doctors/${targetDoctorId}/availability`)
      .query({ from, to })
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(200);

    return response.body as Array<{ startAt: string }>;
  }

  async function bookAs(
    token: string,
    targetDoctorId: string,
    startAt: string,
  ): Promise<{ id: string }> {
    const response = await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${token}`)
      .send({ doctorId: targetDoctorId, startAt })
      .expect(201);

    return response.body as { id: string };
  }

  async function cancelAs(token: string, appointmentId: string): Promise<void> {
    await request(app.getHttpServer())
      .post(`/appointments/${appointmentId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  }

  it('lists slots for a single day', async () => {
    const response = await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/availability`)
      .query({ from: '2026-10-05', to: '2026-10-05' })
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(200);

    expect(response.body).toEqual([
      {
        startAt: '2026-10-05T07:00:00.000Z',
        endAt: '2026-10-05T07:30:00.000Z',
      },
      {
        startAt: '2026-10-05T07:30:00.000Z',
        endAt: '2026-10-05T08:00:00.000Z',
      },
      {
        startAt: '2026-10-05T08:00:00.000Z',
        endAt: '2026-10-05T08:30:00.000Z',
      },
      {
        startAt: '2026-10-05T08:30:00.000Z',
        endAt: '2026-10-05T09:00:00.000Z',
      },
    ]);
  });

  it('returns an empty list for a day with no schedule', async () => {
    const response = await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/availability`)
      .query({ from: '2026-10-06', to: '2026-10-06' }) // Tuesday
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(200);

    expect(response.body).toEqual([]);
  });

  it('excludes slots covered by a block', async () => {
    await createBlock(doctorId, '2026-10-05T07:00:00Z', '2026-10-05T08:00:00Z');

    const response = await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/availability`)
      .query({ from: '2026-10-05', to: '2026-10-05' })
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(200);

    expect(
      response.body.map((slot: { startAt: string }) => slot.startAt),
    ).toEqual(['2026-10-05T08:00:00.000Z', '2026-10-05T08:30:00.000Z']);
  });

  it('excludes a slot once it is booked', async () => {
    const before = await listAvailability(doctorId, '2026-10-05', '2026-10-05');
    expect(before.map((s) => s.startAt)).toContain('2026-10-05T07:00:00.000Z');

    await bookAs(patientToken, doctorId, '2026-10-05T07:00:00.000Z');

    const after = await listAvailability(doctorId, '2026-10-05', '2026-10-05');
    expect(after.map((s) => s.startAt)).not.toContain(
      '2026-10-05T07:00:00.000Z',
    );
    expect(after.length).toBe(before.length - 1);
  });

  it('shows the slot again after it is cancelled', async () => {
    // 08:00Z is 11:00 clinic-local, on this fixture's 10:00-12:00 Monday grid.
    // The plan's 09:00Z is 12:00 local, which is the exclusive window end.
    const appointment = await bookAs(
      patientToken,
      doctorId,
      '2026-10-05T08:00:00.000Z',
    );
    await cancelAs(patientToken, appointment.id);

    const slots = await listAvailability(doctorId, '2026-10-05', '2026-10-05');
    expect(slots.map((s) => s.startAt)).toContain('2026-10-05T08:00:00.000Z');
  });

  it('lists slots across a multi-day range and excludes a block on the final day', async () => {
    await createBlock(doctorId, '2026-10-12T07:00:00Z', '2026-10-12T08:00:00Z');

    const response = await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/availability`)
      .query({ from: '2026-10-05', to: '2026-10-12' }) // two Mondays
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(200);

    expect(
      response.body.map((slot: { startAt: string }) => slot.startAt),
    ).toEqual([
      '2026-10-05T07:00:00.000Z',
      '2026-10-05T07:30:00.000Z',
      '2026-10-05T08:00:00.000Z',
      '2026-10-05T08:30:00.000Z',
      '2026-10-12T08:00:00.000Z',
      '2026-10-12T08:30:00.000Z',
    ]);
  });

  it('rejects a range longer than 62 days', async () => {
    const response = await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/availability`)
      .query({ from: '2026-01-01', to: '2026-06-01' })
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(400);

    expect(response.body.code).toBe('DATE_RANGE_TOO_LARGE');
  });

  it('allows a range of exactly 62 days', async () => {
    await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/availability`)
      .query({ from: '2026-01-01', to: '2026-03-03' })
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(200);
  });

  it('rejects a range of 63 days', async () => {
    const response = await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/availability`)
      .query({ from: '2026-01-01', to: '2026-03-04' })
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(400);

    expect(response.body.code).toBe('DATE_RANGE_TOO_LARGE');
  });

  it('rejects a reversed range', async () => {
    await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/availability`)
      .query({ from: '2026-10-10', to: '2026-10-05' })
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(400);
  });

  it('rejects a malformed date', async () => {
    await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/availability`)
      .query({ from: '05-10-2026', to: '2026-10-05' })
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(400);
  });

  it('rejects a calendar date that matches the format but is not a real day', async () => {
    const response = await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/availability`)
      .query({ from: '2026-02-30', to: '2026-10-05' })
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(400);

    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it('returns 404 for an unknown doctor', async () => {
    await request(app.getHttpServer())
      .get('/doctors/00000000-0000-0000-0000-000000000000/availability')
      .query({ from: '2026-10-05', to: '2026-10-05' })
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(404);
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/availability`)
      .query({ from: '2026-10-05', to: '2026-10-05' })
      .expect(401);
  });
});
