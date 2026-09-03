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

const UNKNOWN_UUID = '99999999-9999-9999-9999-999999999999';

describe('Schedules API', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let admin: SeededActor;
  let doctorA: SeededActor;
  let doctorB: SeededActor;
  let patient: SeededActor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    // Mirrors src/main.ts. Without these two lines the suite would test a
    // different application than the one that gets deployed.
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
    doctorA = await seedDoctor(dataSource, jwt);
    doctorB = await seedDoctor(dataSource, jwt);
    patient = await seedPatient(dataSource, jwt);
  });

  const validBody = {
    dayOfWeek: 0,
    startTime: '10:00',
    endTime: '12:00',
    slotDurationMinutes: 30,
  };

  function post(actor: SeededActor, doctorId: string, body: unknown) {
    return request(app.getHttpServer())
      .post(`/doctors/${doctorId}/schedules`)
      .set('Authorization', `Bearer ${actor.token}`)
      .send(body);
  }

  describe('GET /doctors/:doctorId/schedules', () => {
    it('requires a token', async () => {
      await request(app.getHttpServer())
        .get(`/doctors/${doctorA.doctorId}/schedules`)
        .expect(401);
    });

    it('returns an empty list for a doctor with no schedules, to any authenticated caller', async () => {
      const response = await request(app.getHttpServer())
        .get(`/doctors/${doctorA.doctorId}/schedules`)
        .set('Authorization', `Bearer ${patient.token}`)
        .expect(200);

      expect(response.body).toEqual([]);
    });

    it('returns 404 for an unknown doctor', async () => {
      const response = await request(app.getHttpServer())
        .get(`/doctors/${UNKNOWN_UUID}/schedules`)
        .set('Authorization', `Bearer ${patient.token}`)
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /doctors/:doctorId/schedules', () => {
    it('creates a schedule for the owning doctor and normalises the times', async () => {
      const response = await post(doctorA, doctorA.doctorId!, validBody).expect(
        201,
      );

      expect(response.body).toMatchObject({
        doctorId: doctorA.doctorId,
        dayOfWeek: 0,
        startTime: '10:00:00',
        endTime: '12:00:00',
        slotDurationMinutes: 30,
      });
      expect(response.body.id).toEqual(expect.any(String));
    });

    it('rejects a day_of_week outside 0..6', async () => {
      const response = await post(doctorA, doctorA.doctorId!, {
        ...validBody,
        dayOfWeek: 7,
      }).expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a slot duration that is not 15, 30 or 60', async () => {
      const response = await post(doctorA, doctorA.doctorId!, {
        ...validBody,
        slotDurationMinutes: 45,
      }).expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a start time that is not before the end time', async () => {
      const response = await post(doctorA, doctorA.doctorId!, {
        ...validBody,
        startTime: '16:00',
        endTime: '10:00',
      }).expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects an unknown field in the body', async () => {
      const response = await post(doctorA, doctorA.doctorId!, {
        ...validBody,
        doctorId: doctorB.doctorId,
      }).expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a window overlapping another row on the same weekday', async () => {
      const created = await post(doctorA, doctorA.doctorId!, validBody).expect(
        201,
      );

      const response = await post(doctorA, doctorA.doctorId!, {
        ...validBody,
        startTime: '11:00',
        endTime: '13:00',
      }).expect(409);

      expect(response.body.code).toBe('SCHEDULE_OVERLAP');
      expect(response.body.conflictingScheduleId).toBe(created.body.id);
    });

    it('accepts a window adjacent to an existing one', async () => {
      await post(doctorA, doctorA.doctorId!, validBody).expect(201);

      await post(doctorA, doctorA.doctorId!, {
        ...validBody,
        startTime: '12:00',
        endTime: '16:00',
        slotDurationMinutes: 15,
      }).expect(201);
    });

    it('accepts the same window on a different weekday, with a different duration', async () => {
      await post(doctorA, doctorA.doctorId!, validBody).expect(201);

      await post(doctorA, doctorA.doctorId!, {
        ...validBody,
        dayOfWeek: 1,
        slotDurationMinutes: 15,
      }).expect(201);
    });

    it('forbids a doctor from writing another doctor schedule', async () => {
      const response = await post(doctorB, doctorA.doctorId!, validBody).expect(
        403,
      );

      expect(response.body.code).toBe('FORBIDDEN');
    });

    it('allows an ADMIN to write any doctor schedule', async () => {
      await post(admin, doctorA.doctorId!, validBody).expect(201);
    });

    it('forbids a patient from writing a doctor schedule', async () => {
      const response = await post(patient, doctorA.doctorId!, validBody).expect(
        403,
      );

      expect(response.body.code).toBe('FORBIDDEN');
    });

    it('returns 404 when an ADMIN addresses an unknown doctor', async () => {
      const response = await post(admin, UNKNOWN_UUID, validBody).expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
    });
  });

  describe('PATCH /doctors/:doctorId/schedules/:id', () => {
    it('changes the slot duration without changing the window', async () => {
      const created = await post(doctorA, doctorA.doctorId!, validBody).expect(
        201,
      );

      const response = await request(app.getHttpServer())
        .patch(`/doctors/${doctorA.doctorId}/schedules/${created.body.id}`)
        .set('Authorization', `Bearer ${doctorA.token}`)
        .send({ slotDurationMinutes: 15 })
        .expect(200);

      expect(response.body).toMatchObject({
        id: created.body.id,
        dayOfWeek: 0,
        startTime: '10:00:00',
        endTime: '12:00:00',
        slotDurationMinutes: 15,
      });
    });

    it('allows a row to keep its own window, because it does not overlap itself', async () => {
      const created = await post(doctorA, doctorA.doctorId!, validBody).expect(
        201,
      );

      const response = await request(app.getHttpServer())
        .patch(`/doctors/${doctorA.doctorId}/schedules/${created.body.id}`)
        .set('Authorization', `Bearer ${doctorA.token}`)
        .send({ endTime: '13:00' })
        .expect(200);

      expect(response.body.endTime).toBe('13:00:00');
    });

    it('rejects a change that would overlap another row', async () => {
      const morning = await post(doctorA, doctorA.doctorId!, validBody).expect(
        201,
      );
      await post(doctorA, doctorA.doctorId!, {
        ...validBody,
        startTime: '14:00',
        endTime: '16:00',
      }).expect(201);

      const response = await request(app.getHttpServer())
        .patch(`/doctors/${doctorA.doctorId}/schedules/${morning.body.id}`)
        .set('Authorization', `Bearer ${doctorA.token}`)
        .send({ endTime: '15:00' })
        .expect(409);

      expect(response.body.code).toBe('SCHEDULE_OVERLAP');
    });

    it('forbids a doctor from patching another doctor schedule', async () => {
      const created = await post(doctorA, doctorA.doctorId!, validBody).expect(
        201,
      );

      await request(app.getHttpServer())
        .patch(`/doctors/${doctorA.doctorId}/schedules/${created.body.id}`)
        .set('Authorization', `Bearer ${doctorB.token}`)
        .send({ slotDurationMinutes: 15 })
        .expect(403);
    });

    it('returns 404 when the schedule belongs to a different doctor than the URL', async () => {
      const created = await post(doctorB, doctorB.doctorId!, validBody).expect(
        201,
      );

      const response = await request(app.getHttpServer())
        .patch(`/doctors/${doctorA.doctorId}/schedules/${created.body.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ slotDurationMinutes: 15 })
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
    });
  });

  describe('DELETE /doctors/:doctorId/schedules/:id', () => {
    it('removes the schedule and stops listing it', async () => {
      const created = await post(doctorA, doctorA.doctorId!, validBody).expect(
        201,
      );

      await request(app.getHttpServer())
        .delete(`/doctors/${doctorA.doctorId}/schedules/${created.body.id}`)
        .set('Authorization', `Bearer ${doctorA.token}`)
        .expect(204);

      const list = await request(app.getHttpServer())
        .get(`/doctors/${doctorA.doctorId}/schedules`)
        .set('Authorization', `Bearer ${doctorA.token}`)
        .expect(200);

      expect(list.body).toEqual([]);
    });

    it('returns 404 for another doctor schedule', async () => {
      const created = await post(doctorB, doctorB.doctorId!, validBody).expect(
        201,
      );

      await request(app.getHttpServer())
        .delete(`/doctors/${doctorA.doctorId}/schedules/${created.body.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(404);
    });

    it('forbids a patient from deleting a schedule', async () => {
      const created = await post(doctorA, doctorA.doctorId!, validBody).expect(
        201,
      );

      await request(app.getHttpServer())
        .delete(`/doctors/${doctorA.doctorId}/schedules/${created.body.id}`)
        .set('Authorization', `Bearer ${patient.token}`)
        .expect(403);
    });
  });

  describe('database constraints', () => {
    // These bypass the API on purpose. The service checks exist for good error
    // messages; these prove the database refuses bad rows on its own, which is
    // what protects the seed script and manual psql access.
    it('rejects day_of_week 7 with schedules_day_of_week_valid', async () => {
      await expect(
        dataSource.query(
          `INSERT INTO schedules (doctor_id, day_of_week, start_time, end_time, slot_duration_minutes)
           VALUES ($1, 7, '10:00', '12:00', 30)`,
          [doctorA.doctorId],
        ),
      ).rejects.toThrow(/schedules_day_of_week_valid/);
    });

    it('rejects a 45-minute duration with schedules_slot_duration_valid', async () => {
      await expect(
        dataSource.query(
          `INSERT INTO schedules (doctor_id, day_of_week, start_time, end_time, slot_duration_minutes)
           VALUES ($1, 0, '10:00', '12:00', 45)`,
          [doctorA.doctorId],
        ),
      ).rejects.toThrow(/schedules_slot_duration_valid/);
    });

    it('rejects end_time before start_time with schedules_time_valid', async () => {
      await expect(
        dataSource.query(
          `INSERT INTO schedules (doctor_id, day_of_week, start_time, end_time, slot_duration_minutes)
           VALUES ($1, 0, '12:00', '10:00', 30)`,
          [doctorA.doctorId],
        ),
      ).rejects.toThrow(/schedules_time_valid/);
    });
  });
});
