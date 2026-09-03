import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { BlocksRepository } from '../src/blocks/blocks.repository';
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

describe('Blocks API', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let blocksRepository: BlocksRepository;
  let admin: SeededActor;
  let doctorA: SeededActor;
  let doctorB: SeededActor;
  let patient: SeededActor;

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
    blocksRepository = app.get(BlocksRepository);
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
    startAt: '2026-09-06T07:00:00Z',
    endAt: '2026-09-06T09:00:00Z',
    reason: 'vacation',
  };

  function post(actor: SeededActor, doctorId: string, body: object) {
    return request(app.getHttpServer())
      .post(`/doctors/${doctorId}/blocks`)
      .set('Authorization', `Bearer ${actor.token}`)
      .send(body);
  }

  describe('GET /doctors/:doctorId/blocks', () => {
    it('requires a token', async () => {
      await request(app.getHttpServer())
        .get(`/doctors/${doctorA.doctorId}/blocks`)
        .expect(401);
    });

    it('returns an empty list for a doctor with no blocks', async () => {
      const response = await request(app.getHttpServer())
        .get(`/doctors/${doctorA.doctorId}/blocks`)
        .set('Authorization', `Bearer ${patient.token}`)
        .expect(200);

      expect(response.body).toEqual([]);
    });

    it('returns 404 for an unknown doctor', async () => {
      const response = await request(app.getHttpServer())
        .get(`/doctors/${UNKNOWN_UUID}/blocks`)
        .set('Authorization', `Bearer ${patient.token}`)
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /doctors/:doctorId/blocks', () => {
    it('creates a block for the owning doctor and echoes UTC instants', async () => {
      const response = await post(doctorA, doctorA.doctorId!, validBody).expect(
        201,
      );

      expect(response.body).toMatchObject({
        doctorId: doctorA.doctorId,
        startAt: '2026-09-06T07:00:00.000Z',
        endAt: '2026-09-06T09:00:00.000Z',
        reason: 'vacation',
      });
    });

    it('stores a null reason when none is supplied', async () => {
      const response = await post(doctorA, doctorA.doctorId!, {
        startAt: validBody.startAt,
        endAt: validBody.endAt,
      }).expect(201);

      expect(response.body.reason).toBeNull();
    });

    it('rejects an end instant before the start instant', async () => {
      const response = await post(doctorA, doctorA.doctorId!, {
        ...validBody,
        startAt: '2026-09-06T09:00:00Z',
        endAt: '2026-09-06T07:00:00Z',
      }).expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a zero-length block', async () => {
      const response = await post(doctorA, doctorA.doctorId!, {
        ...validBody,
        endAt: validBody.startAt,
      }).expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a start instant that is not ISO 8601', async () => {
      const response = await post(doctorA, doctorA.doctorId!, {
        ...validBody,
        startAt: 'next tuesday',
      }).expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a block overlapping an existing one', async () => {
      await post(doctorA, doctorA.doctorId!, {
        startAt: '2026-09-06T00:00:00Z',
        endAt: '2026-09-07T00:00:00Z',
        reason: 'vacation',
      }).expect(201);

      const response = await post(doctorA, doctorA.doctorId!, {
        startAt: '2026-09-06T08:00:00Z',
        endAt: '2026-09-06T09:30:00Z',
        reason: 'emergency',
      }).expect(409);

      expect(response.body.code).toBe('BLOCK_OVERLAP');

      const list = await request(app.getHttpServer())
        .get(`/doctors/${doctorA.doctorId}/blocks`)
        .set('Authorization', `Bearer ${doctorA.token}`)
        .expect(200);

      expect(list.body).toHaveLength(1);
    });

    it('accepts a block that starts exactly when another ends', async () => {
      await post(doctorA, doctorA.doctorId!, {
        startAt: '2026-09-06T07:00:00Z',
        endAt: '2026-09-06T09:00:00Z',
        reason: 'emergency',
      }).expect(201);

      await post(doctorA, doctorA.doctorId!, {
        startAt: '2026-09-06T09:00:00Z',
        endAt: '2026-09-06T11:00:00Z',
        reason: 'emergency',
      }).expect(201);
    });

    it('lets two doctors block the same period', async () => {
      await post(doctorA, doctorA.doctorId!, validBody).expect(201);
      await post(doctorB, doctorB.doctorId!, validBody).expect(201);
    });

    it('forbids a doctor from writing another doctor blocks', async () => {
      const response = await post(doctorB, doctorA.doctorId!, validBody).expect(
        403,
      );

      expect(response.body.code).toBe('FORBIDDEN');
    });

    it('allows an ADMIN to write any doctor blocks', async () => {
      await post(admin, doctorA.doctorId!, validBody).expect(201);
    });

    it('forbids a patient from writing blocks', async () => {
      const response = await post(patient, doctorA.doctorId!, validBody).expect(
        403,
      );

      expect(response.body.code).toBe('FORBIDDEN');
    });
  });

  describe('DELETE /doctors/:doctorId/blocks/:id', () => {
    it('removes the block and stops listing it', async () => {
      const created = await post(doctorA, doctorA.doctorId!, validBody).expect(
        201,
      );

      await request(app.getHttpServer())
        .delete(`/doctors/${doctorA.doctorId}/blocks/${created.body.id}`)
        .set('Authorization', `Bearer ${doctorA.token}`)
        .expect(204);

      const list = await request(app.getHttpServer())
        .get(`/doctors/${doctorA.doctorId}/blocks`)
        .set('Authorization', `Bearer ${doctorA.token}`)
        .expect(200);

      expect(list.body).toEqual([]);
    });

    it('returns 404 for another doctor block', async () => {
      const created = await post(doctorB, doctorB.doctorId!, validBody).expect(
        201,
      );

      await request(app.getHttpServer())
        .delete(`/doctors/${doctorA.doctorId}/blocks/${created.body.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(404);
    });
  });

  describe('BlocksRepository.findOverlapping', () => {
    // Plans 4 and 5 subtract blocks from generated slots with this query, so
    // its boundary behaviour has to agree with the half-open '[)' bound used by
    // appointments_no_overlap. Tested against real PostgreSQL because the
    // comparison happens in SQL.
    beforeEach(async () => {
      await post(doctorA, doctorA.doctorId!, {
        startAt: '2026-09-06T07:00:00Z',
        endAt: '2026-09-06T09:00:00Z',
        reason: 'vacation',
      }).expect(201);
    });

    it('finds a block that straddles the requested range', async () => {
      const found = await blocksRepository.findOverlapping(
        doctorA.doctorId!,
        new Date('2026-09-06T08:30:00Z'),
        new Date('2026-09-06T10:00:00Z'),
      );

      expect(found).toHaveLength(1);
    });

    it('ignores a block that ends exactly when the range starts', async () => {
      const found = await blocksRepository.findOverlapping(
        doctorA.doctorId!,
        new Date('2026-09-06T09:00:00Z'),
        new Date('2026-09-06T10:00:00Z'),
      );

      expect(found).toEqual([]);
    });

    it('ignores a block that starts exactly when the range ends', async () => {
      const found = await blocksRepository.findOverlapping(
        doctorA.doctorId!,
        new Date('2026-09-06T06:00:00Z'),
        new Date('2026-09-06T07:00:00Z'),
      );

      expect(found).toEqual([]);
    });

    it('does not return another doctor blocks', async () => {
      const found = await blocksRepository.findOverlapping(
        doctorB.doctorId!,
        new Date('2026-09-06T07:00:00Z'),
        new Date('2026-09-06T09:00:00Z'),
      );

      expect(found).toEqual([]);
    });
  });

  describe('database constraints', () => {
    it('rejects end_at equal to start_at with blocks_time_valid', async () => {
      await expect(
        dataSource.query(
          `INSERT INTO blocks (doctor_id, start_at, end_at)
           VALUES ($1, '2026-09-06T07:00:00Z', '2026-09-06T07:00:00Z')`,
          [doctorA.doctorId],
        ),
      ).rejects.toThrow(/blocks_time_valid/);
    });
  });
});
