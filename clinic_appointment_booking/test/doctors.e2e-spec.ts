import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/auth/password.service';
import { UserRole } from '../src/common/enums/role.enum';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

describe('Doctors', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const adminCredentials = {
    email: 'admin@clinic.test',
    password: 'admin-password-1',
  };

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

    const hash = await app.get(PasswordService).hash(adminCredentials.password);
    await dataSource.query(
      `INSERT INTO users (first_name, last_name, email, password_hash, role)
       VALUES ('Root', 'Admin', $1, $2, $3)`,
      [adminCredentials.email, hash, UserRole.Admin],
    );
  });

  afterAll(async () => {
    await app.close();
  });

  async function tokenFor(email: string, password: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    return response.body.accessToken as string;
  }

  const newDoctor = {
    firstName: 'Omar',
    lastName: 'Fahmy',
    email: 'omar.fahmy@clinic.test',
    password: 'doctor-password-1',
    specialization: 'Cardiology',
  };

  it('lets an admin create a doctor with a linked user account', async () => {
    const token = await tokenFor(
      adminCredentials.email,
      adminCredentials.password,
    );

    const response = await request(app.getHttpServer())
      .post('/doctors')
      .set('Authorization', `Bearer ${token}`)
      .send(newDoctor)
      .expect(201);

    expect(response.body).toEqual({
      id: expect.any(String),
      specialization: 'Cardiology',
      email: 'omar.fahmy@clinic.test',
    });

    const [row] = await dataSource.query(
      `SELECT u.role FROM doctors d JOIN users u ON u.id = d.user_id`,
    );
    expect(row.role).toBe('DOCTOR');
  });

  it('rejects doctor creation by a patient with 403', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        firstName: 'Nadia',
        lastName: 'Hassan',
        email: 'nadia@clinic.test',
        password: 'patient-password-1',
      })
      .expect(201);

    const token = await tokenFor('nadia@clinic.test', 'patient-password-1');

    await request(app.getHttpServer())
      .post('/doctors')
      .set('Authorization', `Bearer ${token}`)
      .send(newDoctor)
      .expect(403);
  });

  it('rejects doctor creation with no token at all', async () => {
    await request(app.getHttpServer())
      .post('/doctors')
      .send(newDoctor)
      .expect(401);
  });

  it('returns the doctor name on GET /doctors/:id', async () => {
    const adminToken = await tokenFor(
      adminCredentials.email,
      adminCredentials.password,
    );
    const created = await request(app.getHttpServer())
      .post('/doctors')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ...newDoctor, achievements: '10 years of practice' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get(`/doctors/${created.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(response.body).toEqual({
      id: created.body.id,
      firstName: 'Omar',
      lastName: 'Fahmy',
      specialization: 'Cardiology',
      achievements: '10 years of practice',
    });
  });

  it('reports the created doctor id on /auth/me for that doctor', async () => {
    const adminToken = await tokenFor(
      adminCredentials.email,
      adminCredentials.password,
    );
    const created = await request(app.getHttpServer())
      .post('/doctors')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(newDoctor)
      .expect(201);

    const doctorToken = await tokenFor(newDoctor.email, newDoctor.password);
    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${doctorToken}`)
      .expect(200);

    expect(me.body).toEqual({
      userId: expect.any(String),
      role: 'DOCTOR',
      doctorId: created.body.id,
    });
  });
});
