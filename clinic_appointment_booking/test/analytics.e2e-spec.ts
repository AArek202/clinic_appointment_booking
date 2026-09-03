import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import {
  createAppointment,
  createDoctor,
  createPatient,
  createSchedule,
  resetAnalyticsData,
  userIdForDoctor,
  userIdForPatient,
} from './fixtures/analytics.fixture';

describe('GET /doctors/:doctorId/analytics', () => {
  let app: INestApplication;
  let ds: DataSource;
  let jwt: JwtService;

  let doctorId: string;
  let otherDoctorId: string;
  let adminToken: string;
  let ownerToken: string;
  let otherDoctorToken: string;
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

    ds = app.get(DataSource);
    jwt = app.get(JwtService);

    await resetAnalyticsData(ds);

    doctorId = await createDoctor(ds, 'owner');
    otherDoctorId = await createDoctor(ds, 'other');
    const patientId = await createPatient(ds, 'viewer');

    // Same fixture as the repository test's first block:
    // Sundays 10:00-12:00 Cairo, 4 Sundays in February 2026 -> 480 minutes.
    await createSchedule(ds, {
      doctorId,
      dayOfWeek: 0,
      startTime: '10:00:00',
      endTime: '12:00:00',
      slotDurationMinutes: 30,
    });
    // Sun 1 Feb 10:00 and 10:30 Cairo, CONFIRMED.
    await createAppointment(ds, {
      doctorId,
      patientId,
      startAt: '2026-02-01T08:00:00Z',
      endAt: '2026-02-01T08:30:00Z',
    });
    await createAppointment(ds, {
      doctorId,
      patientId,
      startAt: '2026-02-01T08:30:00Z',
      endAt: '2026-02-01T09:00:00Z',
    });
    // Sun 8 Feb 11:00 and 11:30 Cairo, CANCELLED.
    await createAppointment(ds, {
      doctorId,
      patientId,
      startAt: '2026-02-08T09:00:00Z',
      endAt: '2026-02-08T09:30:00Z',
      status: 'CANCELLED',
    });
    await createAppointment(ds, {
      doctorId,
      patientId,
      startAt: '2026-02-08T09:30:00Z',
      endAt: '2026-02-08T10:00:00Z',
      status: 'CANCELLED',
    });

    // Tokens are signed directly against the JwtPayload contract in
    // docs/PLANS/00-interfaces.md rather than obtained from /auth/login, so
    // this suite tests the analytics contract and not the login one.
    // JwtAuthGuard resolves doctorId/patientId from the database per request.
    const adminUserId = await createAdmin(ds, 'admin');
    adminToken = jwt.sign({ sub: adminUserId, role: 'ADMIN' });
    ownerToken = jwt.sign({
      sub: await userIdForDoctor(ds, doctorId),
      role: 'DOCTOR',
    });
    otherDoctorToken = jwt.sign({
      sub: await userIdForDoctor(ds, otherDoctorId),
      role: 'DOCTOR',
    });
    patientToken = jwt.sign({
      sub: await userIdForPatient(ds, patientId),
      role: 'PATIENT',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  async function createAdmin(
    dataSource: DataSource,
    label: string,
  ): Promise<string> {
    const [user] = await dataSource.query(
      `INSERT INTO users (first_name, last_name, email, password_hash, role)
       VALUES ($1, 'Admin', $2, 'not-a-real-hash', 'ADMIN')
       RETURNING id`,
      [label, `${label}.admin@analytics.test`],
    );
    return user.id;
  }

  it('returns the computed metrics to an ADMIN for any doctor', async () => {
    const response = await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/analytics?year=2026&month=2`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // total       = 2 CONFIRMED + 2 CANCELLED = 4
    // cancelled   = 2 / 4 * 100              = 50
    // peak hours  = local hour 10, twice (cancelled rows are at hour 11)
    // utilization = 60 booked / 480 available * 100 = 12.5
    expect(response.body).toEqual({
      totalAppointments: 4,
      cancellationRate: 50,
      peakHours: [10],
      utilizationRate: 12.5,
    });
  });

  it('returns the metrics to the owning doctor', async () => {
    const response = await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/analytics?year=2026&month=2`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(response.body.totalAppointments).toBe(4);
  });

  it('rejects a different doctor with 403', async () => {
    const response = await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/analytics?year=2026&month=2`)
      .set('Authorization', `Bearer ${otherDoctorToken}`)
      .expect(403);

    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('rejects a patient with 403', async () => {
    await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/analytics?year=2026&month=2`)
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(403);
  });

  it('rejects an unauthenticated request with 401', async () => {
    await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/analytics?year=2026&month=2`)
      .expect(401);
  });

  it('rejects month 13 with 400', async () => {
    const response = await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/analytics?year=2026&month=13`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);

    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a missing month with 400', async () => {
    await request(app.getHttpServer())
      .get(`/doctors/${doctorId}/analytics?year=2026`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('rejects an unexpected query parameter with 400', async () => {
    await request(app.getHttpServer())
      .get(
        `/doctors/${doctorId}/analytics?year=2026&month=2&doctorId=someone-else`,
      )
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('returns 404 for a doctor that does not exist', async () => {
    const response = await request(app.getHttpServer())
      .get(
        '/doctors/00000000-0000-4000-8000-000000000000/analytics?year=2026&month=2',
      )
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);

    expect(response.body.code).toBe('NOT_FOUND');
  });
});
