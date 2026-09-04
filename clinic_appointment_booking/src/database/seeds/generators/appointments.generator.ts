import { randomUUID } from 'node:crypto';
import { Slot, generateSlots } from '../../../availability/slot-generator';
import { REMINDER_LEAD_HOURS } from '../../../common/constants';
import { AppointmentSource } from '../../../common/enums/appointment-source.enum';
import { AppointmentStatus } from '../../../common/enums/appointment-status.enum';
import { NotificationStatus } from '../../../common/enums/notification-status.enum';
import { NotificationType } from '../../../common/enums/notification-type.enum';
import { encodeCopyRow } from '../copy-writer';
import { PatientOccupancy } from '../occupancy';
import { Rng } from '../random';
import { SeedConfig } from '../seed.config';
import { BlockRow, ScheduleRow } from './schedules.generator';

export const APPOINTMENT_COLUMNS = [
  'id',
  'doctor_id',
  'patient_id',
  'start_at',
  'end_at',
  'status',
  'created_from',
  'created_at',
  'updated_at',
  'cancelled_at',
];

export const NOTIFICATION_COLUMNS = [
  'id',
  'appointment_id',
  'patient_id',
  'type',
  'status',
  'scheduled_at',
  'sent_at',
  'created_at',
];

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** How much denser the most recent month is than the oldest one. */
const RECENCY_WEIGHT_MAX = 2.5;

/** Random draws before falling back to a linear probe. */
const PATIENT_DRAW_ATTEMPTS = 20;

export interface ContestedSlot {
  doctorId: string;
  startAt: Date;
  endAt: Date;
}

export interface AppointmentRecord {
  id: string;
  doctorId: string;
  patientId: string;
  startAt: Date;
  endAt: Date;
  status: AppointmentStatus;
  appointmentRow: string;
  notificationRows: string[];
}

export interface DoctorPlan {
  doctorId: string;
  schedules: ScheduleRow[];
  blocks: BlockRow[];
  appointmentCount: number;
}

export interface GeneratorContext {
  rng: Rng;
  now: Date;
  fromDate: string;
  toDate: string;
  timeZone: string;
  patientIds: string[];
  occupancy: PatientOccupancy;
  config: SeedConfig;
  /** Future slots that already hold a confirmed appointment; waiting lists form here. */
  contested: ContestedSlot[];
}

/**
 * Weighted sampling without replacement (Efraimidis-Spirakis): each candidate
 * gets key = u^(1/w) and the highest k keys win.
 *
 * The weight rises linearly towards the end of the seed window, so recent
 * months are denser than old ones. Without it every month would hold the same
 * number of appointments and the monthly analytics query would return the same
 * figure twenty-four times, which would tell a reader nothing.
 */
export function sampleRecent(grid: Slot[], count: number, rng: Rng): Slot[] {
  const first = grid[0].startAt.getTime();
  const span = Math.max(1, grid[grid.length - 1].startAt.getTime() - first);

  const keyed = grid.map((slot) => {
    const position = (slot.startAt.getTime() - first) / span;
    const weight = 1 + position * (RECENCY_WEIGHT_MAX - 1);
    return { slot, key: Math.pow(rng.next(), 1 / weight) };
  });

  keyed.sort((a, b) => b.key - a.key);
  return keyed.slice(0, count).map((entry) => entry.slot);
}

/**
 * Generates one doctor's appointments, and the notification row that booking
 * would have written alongside each of them.
 *
 * Doctor-side overlap is impossible by construction: every appointment is
 * drawn from this doctor's own slot grid, the grid's slots are consecutive
 * half-open intervals, and sampling is without replacement, so no two chosen
 * slots can overlap. Patient-side overlap is prevented by claiming the
 * patient's 15-minute buckets before the row is emitted. Between them the two
 * exclusion constraints cannot fire, which is why they stay enabled during the
 * load.
 */
export function* generateDoctorAppointments(
  plan: DoctorPlan,
  ctx: GeneratorContext,
): Generator<AppointmentRecord> {
  const grid = generateSlots({
    fromDate: ctx.fromDate,
    toDate: ctx.toDate,
    timeZone: ctx.timeZone,
    schedules: plan.schedules.map((schedule) => ({
      dayOfWeek: schedule.dayOfWeek,
      startTime: schedule.startTime,
      endTime: schedule.endTime,
      slotDurationMinutes: schedule.slotDurationMinutes,
    })),
    blocks: plan.blocks.map((block) => ({
      startAt: block.startAt,
      endAt: block.endAt,
    })),
    booked: [],
  });

  if (grid.length < plan.appointmentCount) {
    throw new Error(
      `Doctor ${plan.doctorId} was asked for ${plan.appointmentCount} appointments but ` +
        `their schedule only yields ${grid.length} slots over ${ctx.fromDate}..${ctx.toDate}. ` +
        `Lower appointmentsPerDoctor or widen the tier's windows in seed.config.ts.`,
    );
  }

  const chosen = sampleRecent(grid, plan.appointmentCount, ctx.rng);
  // Time order gives the GiST index better insert locality than random order.
  chosen.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());

  for (const slot of chosen) {
    if (ctx.rng.chance(ctx.config.cancelledFraction)) {
      // Both exclusion constraints are partial on status = 'CONFIRMED', so a
      // cancelled row is unconstrained: it neither checks nor claims occupancy.
      const patientIndex = ctx.rng.int(0, ctx.patientIds.length - 1);
      yield buildRecord(
        plan.doctorId,
        slot,
        patientIndex,
        AppointmentStatus.Cancelled,
        ctx,
      );

      // A cancelled slot can legitimately be booked again. Generating some of
      // those pairs is what proves the constraints really are partial rather
      // than merely documented as such.
      if (ctx.rng.chance(ctx.config.rebookedFraction)) {
        const rebooker = claimFreePatient(slot, ctx);
        yield buildRecord(
          plan.doctorId,
          slot,
          rebooker,
          AppointmentStatus.Confirmed,
          ctx,
        );
        rememberContested(plan.doctorId, slot, ctx);
      }
      continue;
    }

    const patientIndex = claimFreePatient(slot, ctx);
    yield buildRecord(
      plan.doctorId,
      slot,
      patientIndex,
      AppointmentStatus.Confirmed,
      ctx,
    );
    rememberContested(plan.doctorId, slot, ctx);
  }
}

/**
 * Finds a patient with no confirmed appointment overlapping this slot.
 *
 * Termination: at most one doctor can hold this instant per doctor, so at most
 * `doctors` patients out of `patients` are busy at any moment — 200 out of
 * 120,000 at full scale. A few random draws almost always succeed, and the
 * linear probe is a guarantee rather than a hot path.
 */
function claimFreePatient(slot: Slot, ctx: GeneratorContext): number {
  const total = ctx.patientIds.length;

  for (let attempt = 0; attempt < PATIENT_DRAW_ATTEMPTS; attempt += 1) {
    const candidate = ctx.rng.int(0, total - 1);
    if (ctx.occupancy.isFree(candidate, slot.startAt, slot.endAt)) {
      ctx.occupancy.claim(candidate, slot.startAt, slot.endAt);
      return candidate;
    }
  }

  let index = ctx.rng.int(0, total - 1);
  for (let step = 0; step < total; step += 1) {
    if (ctx.occupancy.isFree(index, slot.startAt, slot.endAt)) {
      ctx.occupancy.claim(index, slot.startAt, slot.endAt);
      return index;
    }
    index = (index + 1) % total;
  }

  throw new Error(
    `Every seeded patient is already busy at ${slot.startAt.toISOString()}. ` +
      `Raise SeedConfig.patients.`,
  );
}

function rememberContested(
  doctorId: string,
  slot: Slot,
  ctx: GeneratorContext,
): void {
  if (
    slot.startAt <= ctx.now ||
    ctx.contested.length >= ctx.config.contestedReservoir
  ) {
    return;
  }
  // Sample rather than collect everything: the reservoir only needs enough
  // distinct future slots to hang the waiting-list entries on.
  if (ctx.rng.chance(0.02)) {
    ctx.contested.push({ doctorId, startAt: slot.startAt, endAt: slot.endAt });
  }
}

function buildRecord(
  doctorId: string,
  slot: Slot,
  patientIndex: number,
  status: AppointmentStatus,
  ctx: GeneratorContext,
): AppointmentRecord {
  const id = randomUUID();
  const patientId = ctx.patientIds[patientIndex];

  const createdAt = new Date(
    slot.startAt.getTime() - ctx.rng.int(1, 30) * DAY_MS,
  );
  const cancelledAt =
    status === AppointmentStatus.Cancelled
      ? new Date(
          createdAt.getTime() +
            ctx.rng.next() * (slot.startAt.getTime() - createdAt.getTime()),
        )
      : null;

  const fromWaitingList =
    status === AppointmentStatus.Confirmed &&
    ctx.rng.chance(ctx.config.waitingListSourceFraction);

  const appointmentRow = encodeCopyRow([
    id,
    doctorId,
    patientId,
    slot.startAt,
    slot.endAt,
    status,
    fromWaitingList ? AppointmentSource.WaitingList : AppointmentSource.Direct,
    createdAt,
    cancelledAt ?? createdAt,
    cancelledAt,
  ]);

  // Booking writes the PENDING reminder row inside the same transaction as the
  // appointment (docs/API.md), so every appointment has exactly one, including
  // ones that were later cancelled.
  const reminderAt = new Date(
    slot.startAt.getTime() - REMINDER_LEAD_HOURS * HOUR_MS,
  );
  const reminderSent =
    reminderAt <= ctx.now && (cancelledAt === null || cancelledAt > reminderAt);

  const notificationRows = [
    encodeCopyRow([
      randomUUID(),
      id,
      patientId,
      NotificationType.Reminder,
      reminderSent ? NotificationStatus.Sent : NotificationStatus.Pending,
      reminderAt,
      reminderSent ? reminderAt : null,
      createdAt,
    ]),
  ];

  if (fromWaitingList) {
    notificationRows.push(
      encodeCopyRow([
        randomUUID(),
        id,
        patientId,
        NotificationType.WaitlistAssigned,
        NotificationStatus.Sent,
        createdAt,
        createdAt,
        createdAt,
      ]),
    );
  }

  return {
    id,
    doctorId,
    patientId,
    startAt: slot.startAt,
    endAt: slot.endAt,
    status,
    appointmentRow,
    notificationRows,
  };
}
