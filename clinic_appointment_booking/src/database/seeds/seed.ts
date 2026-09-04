import 'reflect-metadata';
import { hash } from 'bcryptjs';
import { config as loadDotenv } from 'dotenv';
import { DateTime } from 'luxon';
import { Pool, PoolClient } from 'pg';
import { copyRows } from './copy-writer';
import {
  APPOINTMENT_COLUMNS,
  ContestedSlot,
  GeneratorContext,
  NOTIFICATION_COLUMNS,
  generateDoctorAppointments,
} from './generators/appointments.generator';
import {
  DOCTOR_COLUMNS,
  PATIENT_COLUMNS,
  USER_COLUMNS,
  doctorTierOf,
  generatePeople,
} from './generators/people.generator';
import {
  BLOCK_COLUMNS,
  SCHEDULE_COLUMNS,
  blockToCopyRow,
  buildBlocks,
  buildSchedules,
  scheduleToCopyRow,
} from './generators/schedules.generator';
import {
  WAITING_LIST_COLUMNS,
  generateWaitingList,
} from './generators/waiting-list.generator';
import { PatientOccupancy } from './occupancy';
import { PhaseTimer } from './phase-timer';
import { Rng } from './random';
import { SEED_PASSWORD, resolveScale } from './seed.config';

const TRUNCATE_ORDER =
  'notifications, waiting_list, appointments, blocks, schedules, patients, doctors, users';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required to run the seed`);
  }
  return value;
}

async function assertSafeToSeed(
  client: PoolClient,
  reset: boolean,
): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed with NODE_ENV=production');
  }

  const { rows } = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM appointments',
  );

  if (rows[0].count === '0') {
    return;
  }

  if (!reset) {
    throw new Error(
      `appointments already holds ${rows[0].count} rows. Seeding on top would double the ` +
        `dataset and invalidate every recorded EXPLAIN ANALYZE. Re-run with --reset to wipe first.`,
    );
  }

  await client.query(`TRUNCATE ${TRUNCATE_ORDER} RESTART IDENTITY CASCADE`);
}

async function main(): Promise<void> {
  loadDotenv();

  const config = resolveScale(process.argv);
  const reset = process.argv.includes('--reset');
  const timeZone = requireEnv('CLINIC_TZ');
  const now = new Date();

  const fromDate = DateTime.fromJSDate(now, { zone: timeZone })
    .minus({ months: config.monthsPast })
    .startOf('month')
    .toISODate() as string;
  const toDate = DateTime.fromJSDate(now, { zone: timeZone })
    .plus({ months: config.monthsFuture })
    .endOf('month')
    .toISODate() as string;

  const pool = new Pool({
    connectionString: requireEnv('DATABASE_URL'),
    max: 1,
  });
  const client = await pool.connect();
  const timer = new PhaseTimer();

  try {
    // Safe for a seed: the only thing at risk from a crash is the seed itself,
    // which is re-runnable. It removes one fsync per chunk commit, which is the
    // single largest lever on total runtime.
    await client.query('SET synchronous_commit = off');
    await assertSafeToSeed(client, reset);

    const rng = new Rng(config.randomSeed);
    const passwordHash = await hash(SEED_PASSWORD, 10);
    const people = generatePeople(config, rng, passwordHash, now);

    await timer.run(
      'users',
      () => people.userRows.length,
      () => copyRows(client, 'users', USER_COLUMNS, people.userRows),
    );
    await timer.run(
      'doctors',
      () => people.doctorRows.length,
      () => copyRows(client, 'doctors', DOCTOR_COLUMNS, people.doctorRows),
    );
    await timer.run(
      'patients',
      () => people.patientRows.length,
      () => copyRows(client, 'patients', PATIENT_COLUMNS, people.patientRows),
    );

    const plans = people.doctors.map((doctor) => {
      const tier = doctorTierOf(config.tiers, doctor.tier);
      return {
        doctorId: doctor.id,
        schedules: buildSchedules(doctor.id, tier),
        blocks: buildBlocks(doctor.id, config, rng, fromDate, toDate, timeZone),
        appointmentCount: tier.appointmentsPerDoctor,
      };
    });

    await timer.run(
      'schedules',
      () => plans.reduce((n, plan) => n + plan.schedules.length, 0),
      () =>
        copyRows(
          client,
          'schedules',
          SCHEDULE_COLUMNS,
          plans.flatMap((plan) => plan.schedules.map(scheduleToCopyRow)),
        ),
    );
    await timer.run(
      'blocks',
      () => plans.reduce((n, plan) => n + plan.blocks.length, 0),
      () =>
        copyRows(
          client,
          'blocks',
          BLOCK_COLUMNS,
          plans.flatMap((plan) => plan.blocks.map(blockToCopyRow)),
        ),
    );

    const contested: ContestedSlot[] = [];
    const ctx: GeneratorContext = {
      rng,
      now,
      fromDate,
      toDate,
      timeZone,
      patientIds: people.patientIds,
      occupancy: new PatientOccupancy(
        Date.parse(`${fromDate}T00:00:00Z`),
        people.patientIds.length,
      ),
      config,
      contested,
    };

    let appointmentCount = 0;
    let notificationCount = 0;

    await timer.run(
      'appointments+notifs',
      () => appointmentCount + notificationCount,
      async () => {
        let appointmentChunk: string[] = [];
        let notificationChunk: string[] = [];

        const flush = async (): Promise<void> => {
          if (appointmentChunk.length === 0) {
            return;
          }
          // One transaction per chunk. Notifications reference appointments by
          // foreign key, so they must land in the same transaction as the rows
          // they point at.
          await client.query('BEGIN');
          await copyRows(
            client,
            'appointments',
            APPOINTMENT_COLUMNS,
            appointmentChunk,
          );
          await copyRows(
            client,
            'notifications',
            NOTIFICATION_COLUMNS,
            notificationChunk,
          );
          await client.query('COMMIT');

          appointmentCount += appointmentChunk.length;
          notificationCount += notificationChunk.length;
          process.stdout.write(`  ${appointmentCount} appointments\r`);
          appointmentChunk = [];
          notificationChunk = [];
        };

        for (const plan of plans) {
          for (const record of generateDoctorAppointments(plan, ctx)) {
            appointmentChunk.push(record.appointmentRow);
            notificationChunk.push(...record.notificationRows);
            if (appointmentChunk.length >= config.copyChunkRows) {
              await flush();
            }
          }
        }

        await flush();
        process.stdout.write('\n');
      },
    );

    const waitingListRows = generateWaitingList(
      contested,
      people.patientIds,
      config,
      rng,
      now,
    );
    await timer.run(
      'waiting_list',
      () => waitingListRows.length,
      () =>
        copyRows(client, 'waiting_list', WAITING_LIST_COLUMNS, waitingListRows),
    );

    // ANALYZE gives the planner statistics; without it the first EXPLAIN
    // ANALYZE measures a planner guessing from defaults. VACUUM additionally
    // sets the visibility map, without which an "index only" scan still reads
    // every heap page and understates what the index is worth.
    await timer.run(
      'vacuum analyze',
      () => 0,
      async () => {
        await client.query('VACUUM (ANALYZE) users');
        await client.query('VACUUM (ANALYZE) doctors');
        await client.query('VACUUM (ANALYZE) patients');
        await client.query('VACUUM (ANALYZE) schedules');
        await client.query('VACUUM (ANALYZE) blocks');
        await client.query('VACUUM (ANALYZE) appointments');
        await client.query('VACUUM (ANALYZE) notifications');
        await client.query('VACUUM (ANALYZE) waiting_list');
      },
    );

    const busiest = await client.query<{
      doctor_id: string;
      appointments: string;
    }>(
      `SELECT doctor_id, count(*)::text AS appointments
         FROM appointments GROUP BY doctor_id ORDER BY count(*) DESC LIMIT 3`,
    );

    console.log(`\n${timer.report()}\n`);
    console.log(`scale            : ${config.scale}`);
    console.log(`window           : ${fromDate} .. ${toDate} (${timeZone})`);
    console.log(`login password   : ${SEED_PASSWORD}`);
    console.log(`admin account    : ${people.adminEmail}`);
    console.log('busiest doctors  :');
    for (const row of busiest.rows) {
      console.log(`  ${row.doctor_id}  ${row.appointments}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
