import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { ClockModule } from '../src/common/clock/clock.module';
import { AppConfigModule } from '../src/config/config.module';
import { JobsModule } from '../src/jobs/jobs.module';
import { JobsService } from '../src/jobs/jobs.service';
import { QUEUE_REMINDERS, QUEUE_WAITING_LIST } from '../src/jobs/queue.constants';
import { flushTestRedis } from './redis-helper';

describe('enqueueing jobs', () => {
  let moduleRef: TestingModule;
  let jobs: JobsService;
  let reminders: Queue;
  let waitingList: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, ClockModule, JobsModule],
    }).compile();
    await moduleRef.init();

    jobs = moduleRef.get(JobsService);
    reminders = moduleRef.get<Queue>(getQueueToken(QUEUE_REMINDERS));
    waitingList = moduleRef.get<Queue>(getQueueToken(QUEUE_WAITING_LIST));
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await flushTestRedis();
  });

  it('puts a future reminder in the delayed set', async () => {
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000);

    await jobs.scheduleReminder('11111111-1111-1111-1111-111111111111', scheduledAt);

    await expect(reminders.getDelayedCount()).resolves.toBe(1);
    await expect(reminders.getWaitingCount()).resolves.toBe(0);
  });

  it('puts a past-due reminder straight into the waiting set', async () => {
    const scheduledAt = new Date(Date.now() - 60 * 60 * 1000);

    await jobs.scheduleReminder('11111111-1111-1111-1111-111111111111', scheduledAt);

    await expect(reminders.getWaitingCount()).resolves.toBe(1);
    await expect(reminders.getDelayedCount()).resolves.toBe(0);
  });

  it('collapses two enqueues for the same appointment into one job', async () => {
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000);
    const appointmentId = '11111111-1111-1111-1111-111111111111';

    await jobs.scheduleReminder(appointmentId, scheduledAt);
    await jobs.scheduleReminder(appointmentId, scheduledAt);

    await expect(reminders.getDelayedCount()).resolves.toBe(1);
  });

  it('collapses two enqueues for the same slot into one job', async () => {
    const slotStartAt = new Date('2026-10-01T09:00:00.000Z');

    await jobs.enqueueSlotProcessing('doc-1', slotStartAt);
    await jobs.enqueueSlotProcessing('doc-1', slotStartAt);

    const queued = await waitingList.getJobs(['waiting', 'delayed']);
    expect(queued).toHaveLength(1);
    expect(queued[0].id).toBe('waitlist:doc-1:2026-10-01T09:00:00.000Z');
  });

  it('removing a reminder that does not exist is not an error', async () => {
    await expect(jobs.removeReminder('does-not-exist')).resolves.toBeUndefined();
  });
});
