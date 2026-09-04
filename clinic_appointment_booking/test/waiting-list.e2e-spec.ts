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

// Fixture: Monday 10:00-16:00, 30-minute schedule. CLINIC_TZ is Africa/Cairo;
// October is UTC+3, so 10:00 local is 07:00Z. 2026-10-05 is a Monday.

const NOW_BEFORE_SLOT = new Date('2026-10-05T06:00:00.000Z');

describe('Waiting list API', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let clock: FixedClock;
  let adminToken: string;
  let doctorId: string;
  let patientAToken: string;
  let patientBToken: string;
  let patientCToken: string;

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
    const patientA = await seedPatient(dataSource, jwt);
    const patientB = await seedPatient(dataSource, jwt);
    const patientC = await seedPatient(dataSource, jwt);

    adminToken = admin.token;
    doctorId = doctor.doctorId!;
    patientAToken = patientA.token;
    patientBToken = patientB.token;
    patientCToken = patientC.token;

    await addMondaySchedule(doctorId);
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

  async function bookAs(
    token: string,
    targetDoctorId: string,
    startAt: string,
  ): Promise<void> {
    await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${token}`)
      .send({ doctorId: targetDoctorId, startAt })
      .expect(201);
  }

  async function joinAs(
    token: string,
    targetDoctorId: string,
    slotStartAt: string,
    extra?: { expiresAt?: string },
  ) {
    const response = await request(app.getHttpServer())
      .post('/waiting-list')
      .set('Authorization', `Bearer ${token}`)
      .send({ doctorId: targetDoctorId, slotStartAt, ...extra })
      .expect(201);

    return response.body as { id: string; position: number };
  }

  it('lets a patient join the queue for a taken slot', async () => {
    await bookAs(patientAToken, doctorId, '2026-10-05T07:00:00.000Z');

    const response = await request(app.getHttpServer())
      .post('/waiting-list')
      .set('Authorization', `Bearer ${patientBToken}`)
      .send({ doctorId, slotStartAt: '2026-10-05T07:00:00.000Z' })
      .expect(201);

    expect(response.body).toEqual({
      id: expect.any(String),
      doctorId,
      slotStartAt: '2026-10-05T07:00:00.000Z',
      slotEndAt: '2026-10-05T07:30:00.000Z',
      status: 'WAITING',
      position: 1,
    });
  });

  it('reports increasing positions in join order', async () => {
    await bookAs(patientAToken, doctorId, '2026-10-05T07:00:00.000Z');

    const first = await joinAs(
      patientBToken,
      doctorId,
      '2026-10-05T07:00:00.000Z',
    );
    const second = await joinAs(
      patientCToken,
      doctorId,
      '2026-10-05T07:00:00.000Z',
    );

    expect(first.position).toBe(1);
    expect(second.position).toBe(2);
  });

  it('refuses to queue for a slot that is actually free', async () => {
    const response = await request(app.getHttpServer())
      .post('/waiting-list')
      .set('Authorization', `Bearer ${patientBToken}`)
      .send({ doctorId, slotStartAt: '2026-10-05T07:00:00.000Z' })
      .expect(409);

    expect(response.body.code).toBe('SLOT_IS_AVAILABLE');
  });

  it('refuses a duplicate active entry', async () => {
    await bookAs(patientAToken, doctorId, '2026-10-05T07:00:00.000Z');
    await joinAs(patientBToken, doctorId, '2026-10-05T07:00:00.000Z');

    const response = await request(app.getHttpServer())
      .post('/waiting-list')
      .set('Authorization', `Bearer ${patientBToken}`)
      .send({ doctorId, slotStartAt: '2026-10-05T07:00:00.000Z' })
      .expect(409);

    expect(response.body.code).toBe('ALREADY_IN_WAITING_LIST');
  });

  it('refuses to queue for a slot the patient already holds', async () => {
    await bookAs(patientBToken, doctorId, '2026-10-05T07:00:00.000Z');

    const response = await request(app.getHttpServer())
      .post('/waiting-list')
      .set('Authorization', `Bearer ${patientBToken}`)
      .send({ doctorId, slotStartAt: '2026-10-05T07:00:00.000Z' })
      .expect(409);

    expect(response.body.code).toBe('PATIENT_ALREADY_BOOKED');
  });

  it('rejects a slot that is not on the grid', async () => {
    const response = await request(app.getHttpServer())
      .post('/waiting-list')
      .set('Authorization', `Bearer ${patientBToken}`)
      .send({ doctorId, slotStartAt: '2026-10-05T07:07:00.000Z' })
      .expect(400);

    expect(response.body.code).toBe('SLOT_NOT_ON_GRID');
  });

  it('rejects an expiresAt after the slot start', async () => {
    await bookAs(patientAToken, doctorId, '2026-10-05T07:00:00.000Z');

    await request(app.getHttpServer())
      .post('/waiting-list')
      .set('Authorization', `Bearer ${patientBToken}`)
      .send({
        doctorId,
        slotStartAt: '2026-10-05T07:00:00.000Z',
        expiresAt: '2026-10-05T08:00:00.000Z',
      })
      .expect(400);
  });

  it('lets a patient leave the queue and rejoin afterwards', async () => {
    await bookAs(patientAToken, doctorId, '2026-10-05T07:00:00.000Z');
    const entry = await joinAs(
      patientBToken,
      doctorId,
      '2026-10-05T07:00:00.000Z',
    );

    await request(app.getHttpServer())
      .delete(`/waiting-list/${entry.id}`)
      .set('Authorization', `Bearer ${patientBToken}`)
      .expect(204);

    // The partial unique index only covers WAITING, so rejoining must work.
    await joinAs(patientBToken, doctorId, '2026-10-05T07:00:00.000Z');
  });

  it("refuses to remove another patient's entry", async () => {
    await bookAs(patientAToken, doctorId, '2026-10-05T07:00:00.000Z');
    const entry = await joinAs(
      patientBToken,
      doctorId,
      '2026-10-05T07:00:00.000Z',
    );

    await request(app.getHttpServer())
      .delete(`/waiting-list/${entry.id}`)
      .set('Authorization', `Bearer ${patientCToken}`)
      .expect(403);
  });
});
