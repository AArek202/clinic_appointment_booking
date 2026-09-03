import { AppointmentStatus } from '../../../common/enums/appointment-status.enum';
import { PatientOccupancy } from '../occupancy';
import { Rng } from '../random';
import { SMALL_SCALE } from '../seed.config';
import { buildBlocks, buildSchedules } from './schedules.generator';
import {
  AppointmentRecord,
  GeneratorContext,
  generateDoctorAppointments,
} from './appointments.generator';

const TZ = 'Africa/Cairo';
const FROM = '2026-01-01';
const TO = '2026-06-30';
const NOW = new Date('2026-04-01T09:00:00Z');

function contextFor(patients: number, rng: Rng): GeneratorContext {
  return {
    rng,
    now: NOW,
    fromDate: FROM,
    toDate: TO,
    timeZone: TZ,
    patientIds: Array.from({ length: patients }, (_, i) => `patient-${i}`),
    occupancy: new PatientOccupancy(Date.parse(`${FROM}T00:00:00Z`), patients),
    config: SMALL_SCALE,
    contested: [],
  };
}

function overlaps(a: AppointmentRecord, b: AppointmentRecord): boolean {
  return a.startAt < b.endAt && b.startAt < a.endAt;
}

function collect(records: Iterable<AppointmentRecord>): AppointmentRecord[] {
  return [...records];
}

describe('generateDoctorAppointments', () => {
  const tier = SMALL_SCALE.tiers[1];

  it('never produces two overlapping CONFIRMED rows for the same doctor', () => {
    const rng = new Rng(101);
    const ctx = contextFor(500, rng);
    const records = collect(
      generateDoctorAppointments(
        {
          doctorId: 'doctor-1',
          schedules: buildSchedules('doctor-1', tier),
          blocks: buildBlocks('doctor-1', SMALL_SCALE, rng, FROM, TO, TZ),
          appointmentCount: tier.appointmentsPerDoctor,
        },
        ctx,
      ),
    );

    const confirmed = records
      .filter((record) => record.status === AppointmentStatus.Confirmed)
      .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());

    for (let i = 1; i < confirmed.length; i += 1) {
      expect(overlaps(confirmed[i - 1], confirmed[i])).toBe(false);
    }
  });

  it('never produces two overlapping CONFIRMED rows for the same patient', () => {
    const rng = new Rng(202);
    const ctx = contextFor(300, rng);
    const all: AppointmentRecord[] = [];

    for (let d = 0; d < 3; d += 1) {
      const doctorId = `doctor-${d}`;
      all.push(
        ...collect(
          generateDoctorAppointments(
            {
              doctorId,
              schedules: buildSchedules(doctorId, tier),
              blocks: buildBlocks(doctorId, SMALL_SCALE, rng, FROM, TO, TZ),
              appointmentCount: tier.appointmentsPerDoctor,
            },
            ctx,
          ),
        ),
      );
    }

    const byPatient = new Map<string, AppointmentRecord[]>();
    for (const record of all) {
      if (record.status !== AppointmentStatus.Confirmed) continue;
      const list = byPatient.get(record.patientId) ?? [];
      list.push(record);
      byPatient.set(record.patientId, list);
    }

    for (const list of byPatient.values()) {
      list.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
      for (let i = 1; i < list.length; i += 1) {
        expect(overlaps(list[i - 1], list[i])).toBe(false);
      }
    }
  });

  it('cancels roughly the configured share of appointments', () => {
    const rng = new Rng(303);
    const ctx = contextFor(500, rng);
    const records = collect(
      generateDoctorAppointments(
        {
          doctorId: 'doctor-1',
          schedules: buildSchedules('doctor-1', tier),
          blocks: buildBlocks('doctor-1', SMALL_SCALE, rng, FROM, TO, TZ),
          appointmentCount: tier.appointmentsPerDoctor,
        },
        ctx,
      ),
    );

    const cancelled = records.filter(
      (r) => r.status === AppointmentStatus.Cancelled,
    ).length;
    const ratio = cancelled / records.length;

    expect(ratio).toBeGreaterThan(0.1);
    expect(ratio).toBeLessThan(0.2);
  });

  it('emits exactly one REMINDER notification per appointment', () => {
    const rng = new Rng(404);
    const ctx = contextFor(500, rng);
    const records = collect(
      generateDoctorAppointments(
        {
          doctorId: 'doctor-1',
          schedules: buildSchedules('doctor-1', tier),
          blocks: buildBlocks('doctor-1', SMALL_SCALE, rng, FROM, TO, TZ),
          appointmentCount: tier.appointmentsPerDoctor,
        },
        ctx,
      ),
    );

    for (const record of records) {
      const reminders = record.notificationRows.filter((row) =>
        row.includes('REMINDER'),
      );
      expect(reminders).toHaveLength(1);
    }
  });

  it('fails loudly when a tier asks for more appointments than the grid holds', () => {
    const rng = new Rng(505);
    const ctx = contextFor(50, rng);

    expect(() =>
      collect(
        generateDoctorAppointments(
          {
            doctorId: 'doctor-1',
            schedules: buildSchedules('doctor-1', tier),
            blocks: [],
            appointmentCount: 10_000_000,
          },
          ctx,
        ),
      ),
    ).toThrow(/only yields/);
  });
});
