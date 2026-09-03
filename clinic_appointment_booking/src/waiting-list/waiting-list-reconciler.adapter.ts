import { Injectable } from '@nestjs/common';
import {
  StrandedSlot,
  WaitingListReconciler,
} from '../jobs/waiting-list-reconciler';
import { WaitingListRepository } from './waiting-list.repository';

@Injectable()
export class WaitingListReconcilerAdapter extends WaitingListReconciler {
  constructor(private readonly entries: WaitingListRepository) {
    super();
  }

  async findStrandedSlots(_now: Date, limit: number): Promise<StrandedSlot[]> {
    // SlotWithWaiters is structurally identical to StrandedSlot.
    return this.entries.findSlotsWithWaiters(limit);
  }

  expireStale(now: Date): Promise<number> {
    return this.entries.expireStale(now);
  }
}
