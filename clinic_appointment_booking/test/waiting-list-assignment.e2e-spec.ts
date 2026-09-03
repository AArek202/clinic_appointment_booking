import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Job, Queue } from 'bullmq';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppointmentsService } from '../src/appointments/appointments.service';
import { AppModule } from '../src/app.module';
import { Clock, FixedClock } from '../src/common/clock/clock';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { WaitingListProcessor } from '../src/jobs/waiting-list.processor';
import {
  JOB_PROCESS_SLOT,
  ProcessSlotJobData,
  QUEUE_WAITING_LIST,
} from '../src/jobs/queue.constants';
import { NotificationsRepository } from '../src/notifications/notifications.repository';
import { WaitingListRepository } from '../src/waiting-list/waiting-list.repository';
import {
  createJwtService,
  seedAdmin,
  seedDoctor,
  seedPatient,
  truncateAll,
} from './helpers/seed.helper';
import { flushTestRedis } from './redis-helper';

// Fixture: Monday 10:00-16:00, 30-minute schedule. CLINIC_TZ is Africa/Cairo;
// October is UTC+3, so 12:00 local is 09:00Z. 2026-10-05 is a Monday.

const SLOT = '2026-10-05T09:00:00.000Z';
const NOW_BEFORE_SLOT = new Date('2026-10-05T06:00:00.000Z');

function jobFor(
  doctorId: string,
  slotStartAtIso: string,
): Job<ProcessSlotJobData> {
  return {
    id: 'test-job',
    name: JOB_PROCESS_SLOT,
    data: { doctorId, slotStartAtIso },
    attemptsMade: 0,
  } as Job<ProcessSlotJobData>;
}

describe('WaitingListProcessor', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let processor: WaitingListProcessor;
  let waitingListQueue: Queue;
  let clock: FixedClock;
  let adminToken: string;
  let doctorId: string;
  let secondDoctorId: string;
  let patientAToken: string;
  let patientBToken: string;
  let patientCToken: string;
  let patientDToken: string;
  let patientBId: string;
  let patientCId: string;
  let patientDId: string;

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
    waitingListQueue = app.get<Queue>(getQueueToken(QUEUE_WAITING_LIST));
    processor = new WaitingListProcessor(
      app.get(WaitingListRepository),
      app.get(AppointmentsService),
      app.get(NotificationsRepository),
      clock,
      app.get(DataSource),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    clock.set(NOW_BEFORE_SLOT);
    await flushTestRedis();
    await truncateAll(dataSource);

    const jwt = createJwtService();
    const admin = await seedAdmin(dataSource, jwt);
    const doctor = await seedDoctor(dataSource, jwt);
    const secondDoctor = await seedDoctor(dataSource, jwt);
    const patientA = await seedPatient(dataSource, jwt);
    const patientB = await seedPatient(dataSource, jwt);
    const patientC = await seedPatient(dataSource, jwt);
    const patientD = await seedPatient(dataSource, jwt);

    adminToken = admin.token;
    doctorId = doctor.doctorId!;
    secondDoctorId = secondDoctor.doctorId!;
    patientAToken = patientA.token;
    patientBToken = patientB.token;
    patientCToken = patientC.token;
    patientDToken = patientD.token;
    patientBId = patientB.patientId!;
    patientCId = patientC.patientId!;
    patientDId = patientD.patientId!;

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

  async function joinAs(
    token: string,
    targetDoctorId: string,
    slotStartAt: string,
    extra?: { expiresAt?: string },
  ): Promise<void> {
    await request(app.getHttpServer())
      .post('/waiting-list')
      .set('Authorization', `Bearer ${token}`)
      .send({ doctorId: targetDoctorId, slotStartAt, ...extra })
      .expect(201);
  }

  it('assigns a freed slot to the first waiter', async () => {
    const appointment = await bookAs(patientAToken, doctorId, SLOT);
    await joinAs(patientBToken, doctorId, SLOT);
    await cancelAs(patientAToken, appointment.id);

    await processor.process(jobFor(doctorId, SLOT));

    const [row] = await dataSource.query(
      `SELECT patient_id, created_from FROM appointments
        WHERE status = 'CONFIRMED' AND start_at = $1`,
      [SLOT],
    );
    expect(row.patient_id).toBe(patientBId);
    expect(row.created_from).toBe('WAITING_LIST');

    const [entry] = await dataSource.query(`SELECT status FROM waiting_list`);
    expect(entry.status).toBe('ASSIGNED');
  });

  it('assigns in FIFO order, not to the last joiner', async () => {
    const appointment = await bookAs(patientAToken, doctorId, SLOT);
    await joinAs(patientBToken, doctorId, SLOT);
    await joinAs(patientCToken, doctorId, SLOT);
    await cancelAs(patientAToken, appointment.id);

    await processor.process(jobFor(doctorId, SLOT));

    const [row] = await dataSource.query(
      `SELECT patient_id FROM appointments WHERE status = 'CONFIRMED' AND start_at = $1`,
      [SLOT],
    );
    expect(row.patient_id).toBe(patientBId);
  });

  it('skips a candidate who is busy elsewhere and assigns the next one', async () => {
    const appointment = await bookAs(patientAToken, doctorId, SLOT);
    await joinAs(patientBToken, doctorId, SLOT);
    await joinAs(patientCToken, doctorId, SLOT);
    await bookAs(patientBToken, secondDoctorId, SLOT);
    await cancelAs(patientAToken, appointment.id);

    await processor.process(jobFor(doctorId, SLOT));

    const [row] = await dataSource.query(
      `SELECT patient_id FROM appointments
        WHERE doctor_id = $1 AND status = 'CONFIRMED' AND start_at = $2`,
      [doctorId, SLOT],
    );
    expect(row.patient_id).toBe(patientCId);

    const rows = await dataSource.query(
      `SELECT patient_id, status FROM waiting_list ORDER BY created_at`,
    );
    expect(rows[0]).toMatchObject({
      patient_id: patientBId,
      status: 'WAITING',
    });
    expect(rows[1]).toMatchObject({
      patient_id: patientCId,
      status: 'ASSIGNED',
    });
  });

  it('does nothing when a direct booking already took the freed slot', async () => {
    const appointment = await bookAs(patientAToken, doctorId, SLOT);
    await joinAs(patientBToken, doctorId, SLOT);
    await cancelAs(patientAToken, appointment.id);
    await bookAs(patientDToken, doctorId, SLOT);

    await expect(processor.process(jobFor(doctorId, SLOT))).resolves.not.toThrow();

    const [row] = await dataSource.query(
      `SELECT patient_id FROM appointments WHERE status = 'CONFIRMED' AND start_at = $1`,
      [SLOT],
    );
    expect(row.patient_id).toBe(patientDId);

    const [entry] = await dataSource.query(`SELECT status FROM waiting_list`);
    expect(entry.status).toBe('WAITING');
  });

  it('is idempotent: running twice assigns the slot only once', async () => {
    const appointment = await bookAs(patientAToken, doctorId, SLOT);
    await joinAs(patientBToken, doctorId, SLOT);
    await joinAs(patientCToken, doctorId, SLOT);
    await cancelAs(patientAToken, appointment.id);

    await processor.process(jobFor(doctorId, SLOT));
    await processor.process(jobFor(doctorId, SLOT));

    const [{ count }] = await dataSource.query(
      `SELECT count(*)::int AS count FROM appointments
        WHERE status = 'CONFIRMED' AND start_at = $1`,
      [SLOT],
    );
    expect(count).toBe(1);

    const [{ assigned }] = await dataSource.query(
      `SELECT count(*)::int AS assigned FROM waiting_list WHERE status = 'ASSIGNED'`,
    );
    expect(assigned).toBe(1);
  });

  it('skips an expired entry', async () => {
    const appointment = await bookAs(patientAToken, doctorId, SLOT);
    await joinAs(patientBToken, doctorId, SLOT, {
      expiresAt: '2026-10-05T05:00:00.000Z',
    });
    await joinAs(patientCToken, doctorId, SLOT);
    await cancelAs(patientAToken, appointment.id);

    await processor.process(jobFor(doctorId, SLOT));

    const [row] = await dataSource.query(
      `SELECT patient_id FROM appointments WHERE status = 'CONFIRMED' AND start_at = $1`,
      [SLOT],
    );
    expect(row.patient_id).toBe(patientCId);
  });

  it('creates a reminder notification for the assigned appointment', async () => {
    const appointment = await bookAs(patientAToken, doctorId, SLOT);
    await joinAs(patientBToken, doctorId, SLOT);
    await cancelAs(patientAToken, appointment.id);

    await processor.process(jobFor(doctorId, SLOT));

    const rows = await dataSource.query(
      `SELECT type, status FROM notifications ORDER BY type`,
    );
    expect(rows).toEqual([
      { type: 'REMINDER', status: 'PENDING' },
      { type: 'WAITLIST_ASSIGNED', status: 'PENDING' },
    ]);
  });

  it('does nothing and does not throw when the queue is empty', async () => {
    const appointment = await bookAs(patientAToken, doctorId, SLOT);
    await cancelAs(patientAToken, appointment.id);

    await expect(processor.process(jobFor(doctorId, SLOT))).resolves.not.toThrow();
  });

  it('enqueues waiting-list processing after a cancellation commits', async () => {
    const appointment = await bookAs(patientAToken, doctorId, SLOT);
    await joinAs(patientBToken, doctorId, SLOT);

    await cancelAs(patientAToken, appointment.id);

    const jobs = await waitingListQueue.getJobs([
      'waiting',
      'delayed',
      'active',
      'completed',
    ]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toEqual({
      doctorId,
      slotStartAtIso: SLOT,
    });
  });

  it('collapses duplicate enqueues for the same slot into one job', async () => {
    const first = await bookAs(patientAToken, doctorId, SLOT);
    await cancelAs(patientAToken, first.id);

    const second = await bookAs(patientDToken, doctorId, SLOT);
    await cancelAs(patientDToken, second.id);

    const jobs = await waitingListQueue.getJobs([
      'waiting',
      'delayed',
      'active',
      'completed',
    ]);
    expect(jobs).toHaveLength(1);
  });
});
