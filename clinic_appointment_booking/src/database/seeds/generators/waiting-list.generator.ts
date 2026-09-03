import { randomUUID } from 'node:crypto';
import { WaitingListStatus } from '../../../common/enums/waiting-list-status.enum';
import { encodeCopyRow } from '../copy-writer';
import { Rng } from '../random';
import { SeedConfig } from '../seed.config';
import { ContestedSlot } from './appointments.generator';

export const WAITING_LIST_COLUMNS = [
  'id',
  'doctor_id',
  'patient_id',
  'slot_start_at',
  'slot_end_at',
  'status',
  'expires_at',
  'created_at',
  'updated_at',
];

const DAY_MS = 86_400_000;

/**
 * Hangs waiting-list entries on slots that already hold a confirmed
 * appointment, because that is the only place a queue can form.
 *
 * waiting_list_one_active is a partial unique index on
 * (doctor_id, patient_id, slot_start_at) WHERE status = 'WAITING', so the
 * generator tracks the WAITING triples it has already emitted and skips
 * duplicates rather than relying on the odds.
 */
export function generateWaitingList(
  contested: ContestedSlot[],
  patientIds: string[],
  config: SeedConfig,
  rng: Rng,
  now: Date,
): string[] {
  if (contested.length === 0) {
    return [];
  }

  const rows: string[] = [];
  const activeKeys = new Set<string>();

  while (rows.length < config.waitingListEntries) {
    const slot = rng.pick(contested);
    const patientId = rng.pick(patientIds);

    // 70% still waiting, 20% expired, 8% assigned, 2% withdrawn.
    const roll = rng.next();
    const status =
      roll < 0.7
        ? WaitingListStatus.Waiting
        : roll < 0.9
          ? WaitingListStatus.Expired
          : roll < 0.98
            ? WaitingListStatus.Assigned
            : WaitingListStatus.Cancelled;

    if (status === WaitingListStatus.Waiting) {
      const key = `${slot.doctorId}|${patientId}|${slot.startAt.toISOString()}`;
      if (activeKeys.has(key)) {
        continue;
      }
      activeKeys.add(key);
    }

    const createdAt = new Date(
      slot.startAt.getTime() - rng.int(2, 45) * DAY_MS,
    );
    // expires_at must be before slot_start_at (docs/FEATURES/WaitingList.md).
    const expiresAt = rng.chance(0.3)
      ? new Date(slot.startAt.getTime() - rng.int(1, 2) * DAY_MS)
      : null;

    rows.push(
      encodeCopyRow([
        randomUUID(),
        slot.doctorId,
        patientId,
        slot.startAt,
        slot.endAt,
        status,
        expiresAt,
        createdAt,
        status === WaitingListStatus.Waiting ? createdAt : now,
      ]),
    );
  }

  return rows;
}
