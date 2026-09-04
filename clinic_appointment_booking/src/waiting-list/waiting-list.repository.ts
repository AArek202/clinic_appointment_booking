import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, LessThan, Repository } from 'typeorm';
import { WaitingListStatus } from '../common/enums/waiting-list-status.enum';
import { WaitingListEntry } from './waiting-list-entry.entity';

export interface InsertWaitingParams {
  doctorId: string;
  patientId: string;
  slotStartAt: Date;
  slotEndAt: Date;
  expiresAt: Date | null;
}

export interface SlotWithWaiters {
  doctorId: string;
  slotStartAt: Date;
}

@Injectable()
export class WaitingListRepository {
  constructor(
    @InjectRepository(WaitingListEntry)
    private readonly repo: Repository<WaitingListEntry>,
  ) {}

  /** Does not catch the unique violation: the caller maps it to a 409. */
  insertWaiting(params: InsertWaitingParams): Promise<WaitingListEntry> {
    return this.repo.save(
      this.repo.create({ ...params, status: WaitingListStatus.Waiting }),
    );
  }

  findById(id: string): Promise<WaitingListEntry | null> {
    return this.repo.findOne({ where: { id } });
  }

  /**
   * Eligible candidates for a freed slot, oldest first, row-locked.
   *
   * SKIP LOCKED means two workers processing the same slot never pick the
   * same patient: the second worker skips rows the first has locked instead
   * of blocking on them.
   */
  findCandidates(
    manager: EntityManager,
    doctorId: string,
    slotStartAt: Date,
    limit: number,
    now: Date,
  ): Promise<WaitingListEntry[]> {
    return manager
      .createQueryBuilder(WaitingListEntry, 'w')
      .where('w.doctor_id = :doctorId', { doctorId })
      .andWhere('w.slot_start_at = :slotStartAt', { slotStartAt })
      .andWhere('w.status = :status', { status: WaitingListStatus.Waiting })
      .andWhere('(w.expires_at IS NULL OR w.expires_at > :now)', { now })
      .andWhere('w.slot_start_at > :now', { now })
      .orderBy('w.created_at', 'ASC')
      .limit(limit)
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .getMany();
  }

  /**
   * Conditional WAITING -> ASSIGNED.
   * False means another worker already took this entry.
   */
  async markAssigned(
    manager: EntityManager,
    entryId: string,
  ): Promise<boolean> {
    const result = await manager
      .createQueryBuilder()
      .update(WaitingListEntry)
      .set({ status: WaitingListStatus.Assigned })
      .where('id = :entryId AND status = :status', {
        entryId,
        status: WaitingListStatus.Waiting,
      })
      .execute();

    return (result.affected ?? 0) > 0;
  }

  async markStatus(
    entryId: string,
    from: WaitingListStatus,
    to: WaitingListStatus,
  ): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(WaitingListEntry)
      .set({ status: to })
      .where('id = :entryId AND status = :from', { entryId, from })
      .execute();

    return (result.affected ?? 0) > 0;
  }

  /** Queue position: how many active entries were created before this one. */
  async countAhead(entry: WaitingListEntry): Promise<number> {
    return this.repo.count({
      where: {
        doctorId: entry.doctorId,
        slotStartAt: entry.slotStartAt,
        status: WaitingListStatus.Waiting,
        createdAt: LessThan(entry.createdAt),
      },
    });
  }

  listForPatient(patientId: string): Promise<WaitingListEntry[]> {
    return this.repo.find({
      where: { patientId, status: WaitingListStatus.Waiting },
      order: { slotStartAt: 'ASC' },
    });
  }

  /** Sweeper: expire entries whose deadline or slot time has passed. */
  async expireStale(now: Date): Promise<number> {
    const result = await this.repo.query(
      `UPDATE waiting_list
          SET status = 'EXPIRED', updated_at = now()
        WHERE status = 'WAITING'
          AND (slot_start_at <= $1 OR (expires_at IS NOT NULL AND expires_at <= $1))`,
      [now],
    );

    // node-postgres returns the row count as the second element for UPDATE.
    return Array.isArray(result) ? (result[1] as number) : 0;
  }

  /**
   * Sweeper: slots that are free (no CONFIRMED appointment) but still have
   * waiters. These are the assignments a lost enqueue would have dropped.
   */
  findSlotsWithWaiters(limit: number): Promise<SlotWithWaiters[]> {
    return this.repo.query(
      `SELECT DISTINCT w.doctor_id AS "doctorId", w.slot_start_at AS "slotStartAt"
         FROM waiting_list w
        WHERE w.status = 'WAITING'
          AND w.slot_start_at > now()
          AND NOT EXISTS (
                SELECT 1 FROM appointments a
                 WHERE a.doctor_id = w.doctor_id
                   AND a.status = 'CONFIRMED'
                   AND tstzrange(a.start_at, a.end_at, '[)')
                       && tstzrange(w.slot_start_at, w.slot_end_at, '[)')
              )
        LIMIT $1`,
      [limit],
    );
  }
}
