import {
  RECONCILE_EVERY_MS,
  processSlotJobId,
  sendReminderJobId,
  sweepReminderJobId,
} from './queue.constants';

describe('job ids', () => {
  it('derives the same reminder id for the same appointment', () => {
    const id = sendReminderJobId('11111111-1111-1111-1111-111111111111');

    expect(id).toBe('reminder:11111111-1111-1111-1111-111111111111');
    expect(sendReminderJobId('11111111-1111-1111-1111-111111111111')).toBe(id);
  });

  it('derives the same slot id for the same doctor and slot', () => {
    const slotStartAt = new Date('2026-10-01T09:00:00.000Z');

    expect(processSlotJobId('doc-1', slotStartAt)).toBe(
      'waitlist:doc-1:2026-10-01T09:00:00.000Z',
    );
  });

  it('gives two sweeps in the same minute the same reminder id', () => {
    const first = new Date('2026-10-01T09:00:01.000Z');
    const second = new Date('2026-10-01T09:00:59.000Z');

    expect(sweepReminderJobId('appt-1', first)).toBe(
      sweepReminderJobId('appt-1', second),
    );
  });

  it('gives the next sweep a different reminder id', () => {
    const first = new Date('2026-10-01T09:00:00.000Z');
    const next = new Date(first.getTime() + RECONCILE_EVERY_MS);

    expect(sweepReminderJobId('appt-1', next)).not.toBe(
      sweepReminderJobId('appt-1', first),
    );
  });
});
