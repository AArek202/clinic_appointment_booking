import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Clock, FixedClock } from '../common/clock/clock';
import { JobsService } from './jobs.service';
import {
  JOB_PROCESS_SLOT,
  JOB_SEND_REMINDER,
  QUEUE_REMINDERS,
  QUEUE_WAITING_LIST,
} from './queue.constants';

const NOW = new Date('2026-10-01T09:00:00.000Z');

describe('JobsService', () => {
  const reminders = { add: jest.fn(), remove: jest.fn() };
  const waitingList = { add: jest.fn() };
  let service: JobsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        JobsService,
        { provide: Clock, useValue: new FixedClock(NOW) },
        { provide: getQueueToken(QUEUE_REMINDERS), useValue: reminders },
        { provide: getQueueToken(QUEUE_WAITING_LIST), useValue: waitingList },
      ],
    }).compile();

    service = moduleRef.get(JobsService);
  });

  it('delays a future reminder by the remaining time', async () => {
    await service.scheduleReminder('appt-1', new Date('2026-10-02T09:00:00.000Z'));

    expect(reminders.add).toHaveBeenCalledWith(
      JOB_SEND_REMINDER,
      { appointmentId: 'appt-1' },
      { jobId: 'reminder:appt-1', delay: 86_400_000 },
    );
  });

  it('fires a reminder scheduled in the past immediately', async () => {
    await service.scheduleReminder('appt-1', new Date('2026-09-30T09:00:00.000Z'));

    expect(reminders.add).toHaveBeenCalledWith(
      JOB_SEND_REMINDER,
      { appointmentId: 'appt-1' },
      { jobId: 'reminder:appt-1' },
    );
  });

  it('never sends a negative delay to BullMQ', async () => {
    await service.scheduleReminder('appt-1', new Date('2020-01-01T00:00:00.000Z'));

    const options = reminders.add.mock.calls[0][2] as { delay?: number };
    expect(options.delay).toBeUndefined();
  });

  it('enqueues slot processing with the deterministic slot id', async () => {
    await service.enqueueSlotProcessing('doc-1', new Date('2026-10-01T11:00:00.000Z'));

    expect(waitingList.add).toHaveBeenCalledWith(
      JOB_PROCESS_SLOT,
      { doctorId: 'doc-1', slotStartAtIso: '2026-10-01T11:00:00.000Z' },
      { jobId: 'waitlist:doc-1:2026-10-01T11:00:00.000Z' },
    );
  });

  it('swallows a failure to remove a reminder job', async () => {
    reminders.remove.mockRejectedValueOnce(new Error('Redis is down'));

    await expect(service.removeReminder('appt-1')).resolves.toBeUndefined();
  });
});
