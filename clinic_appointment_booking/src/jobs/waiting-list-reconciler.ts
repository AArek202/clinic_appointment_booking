import { Injectable } from '@nestjs/common';

export interface StrandedSlot {
  doctorId: string;
  slotStartAt: Date;
}

/**
 * The two sweeper passes that need the waiting_list table.
 *
 * The table arrives in Plan 7. Keeping these reads behind one small abstract
 * class lets the sweeper be built, tested and shipped now, and lets Plan 7
 * enable it by swapping one provider binding.
 */
export abstract class WaitingListReconciler {
  /**
   * Slots whose appointment is CANCELLED but which still have WAITING entries.
   * These are the slots whose waiting-list job was lost, or never enqueued
   * because the process died between COMMIT and queue.add.
   */
  abstract findStrandedSlots(now: Date, limit: number): Promise<StrandedSlot[]>;

  /**
   * Marks entries EXPIRED where expires_at or slot_start_at has passed.
   * Returns how many were expired.
   */
  abstract expireStale(now: Date): Promise<number>;
}

/** Bound until Plan 7 creates the waiting_list table. */
@Injectable()
export class NoWaitingListReconciler extends WaitingListReconciler {
  async findStrandedSlots(): Promise<StrandedSlot[]> {
    return [];
  }

  async expireStale(): Promise<number> {
    return 0;
  }
}
