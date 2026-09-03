import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

describe('Auth', () => {
  let app: INestApplication;
  let dataSource: DataSource;

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

  beforeEach(async () => {
    await dataSource.query('TRUNCATE patients, doctors, users CASCADE');
  });

  afterAll(async () => {
    await app.close();
  });

  const validRegistration = {
    firstName: 'Nadia',
    lastName: 'Hassan',
    email: 'Nadia.Hassan@example.com',
    password: 'correct-horse-battery',
  };

  it('registers a patient and stores the email lowercased', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send(validRegistration)
      .expect(201);

    expect(response.body).toEqual({
      id: expect.any(String),
      email: 'nadia.hassan@example.com',
      role: 'PATIENT',
    });

    const [row] = await dataSource.query(
      'SELECT role, password_hash FROM users',
    );
    expect(row.role).toBe('PATIENT');
    expect(row.password_hash).not.toContain('correct-horse-battery');
  });

  it('creates a matching patient profile', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send(validRegistration)
      .expect(201);

    const [{ count }] = await dataSource.query(
      'SELECT count(*)::int AS count FROM patients',
    );
    expect(count).toBe(1);
  });

  it('rejects a request attempting to set its own role', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ ...validRegistration, role: 'ADMIN' })
      .expect(400);
  });

  it('rejects a duplicate email regardless of case', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send(validRegistration)
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ ...validRegistration, email: 'NADIA.HASSAN@example.com' })
      .expect(409);

    expect(response.body.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('logs in with correct credentials and returns a token', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send(validRegistration)
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: validRegistration.email,
        password: validRegistration.password,
      })
      .expect(200);

    expect(typeof response.body.accessToken).toBe('string');
  });

  it('rejects a wrong password with 401', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send(validRegistration)
      .expect(201);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: validRegistration.email, password: 'nope' })
      .expect(401);
  });

  it('rejects an unknown email with 401, not 404', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'nope' })
      .expect(401);
  });
});
