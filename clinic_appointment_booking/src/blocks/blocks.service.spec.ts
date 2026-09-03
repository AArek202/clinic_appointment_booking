import { NotFoundException } from '@nestjs/common';
import { BadRequestError, ConflictError } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-code.enum';
import { Block } from './block.entity';
import { BlocksRepository, NewBlock } from './blocks.repository';
import { BlocksService } from './blocks.service';

const DOCTOR_ID = '11111111-1111-1111-1111-111111111111';
const BLOCK_ID = '22222222-2222-2222-2222-222222222222';

function blockRow(overrides: Partial<Block> = {}): Block {
  return {
    id: BLOCK_ID,
    doctorId: DOCTOR_ID,
    startAt: new Date('2026-09-06T07:00:00.000Z'),
    endAt: new Date('2026-09-06T09:00:00.000Z'),
    reason: 'vacation',
    ...overrides,
  };
}

function makeService() {
  const repository = {
    doctorExists: jest.fn().mockResolvedValue(true),
    findByDoctorId: jest.fn().mockResolvedValue([]),
    findByIdForDoctor: jest.fn().mockResolvedValue(null),
    findOverlapping: jest.fn().mockResolvedValue([]),
    insert: jest.fn((params: NewBlock) => Promise.resolve(blockRow(params))),
    deleteById: jest.fn().mockResolvedValue(undefined),
  };

  const service = new BlocksService(repository as unknown as BlocksRepository);

  return { repository, service };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected the call to be rejected, but it resolved');
    },
    (error: unknown) => error,
  );
}

describe('BlocksService.create', () => {
  it('throws NotFoundException when the doctor does not exist', async () => {
    const { repository, service } = makeService();
    repository.doctorExists.mockResolvedValue(false);

    const error = await rejection(
      service.create(DOCTOR_ID, {
        startAt: '2026-09-06T07:00:00Z',
        endAt: '2026-09-06T09:00:00Z',
      }),
    );

    expect(error).toBeInstanceOf(NotFoundException);
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('rejects an end instant before the start instant', async () => {
    const { service } = makeService();

    const error = await rejection(
      service.create(DOCTOR_ID, {
        startAt: '2026-09-06T09:00:00Z',
        endAt: '2026-09-06T07:00:00Z',
      }),
    );

    expect(error).toBeInstanceOf(BadRequestError);
    expect((error as BadRequestError).code).toBe(ErrorCode.ValidationFailed);
  });

  it('rejects a zero-length block', async () => {
    const { service } = makeService();

    const error = await rejection(
      service.create(DOCTOR_ID, {
        startAt: '2026-09-06T07:00:00Z',
        endAt: '2026-09-06T07:00:00Z',
      }),
    );

    expect(error).toBeInstanceOf(BadRequestError);
  });

  it('persists parsed instants and a null reason when none is supplied', async () => {
    const { repository, service } = makeService();

    await service.create(DOCTOR_ID, {
      startAt: '2026-09-06T07:00:00Z',
      endAt: '2026-09-06T09:00:00Z',
    });

    expect(repository.insert).toHaveBeenCalledWith({
      doctorId: DOCTOR_ID,
      startAt: new Date('2026-09-06T07:00:00.000Z'),
      endAt: new Date('2026-09-06T09:00:00.000Z'),
      reason: null,
    });
  });

  it('rejects a block overlapping an existing one', async () => {
    const { repository, service } = makeService();
    repository.findOverlapping.mockResolvedValue([blockRow()]);

    const error = await rejection(
      service.create(DOCTOR_ID, {
        startAt: '2026-09-06T08:00:00Z',
        endAt: '2026-09-06T10:00:00Z',
        reason: 'emergency',
      }),
    );

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe(ErrorCode.BlockOverlap);
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('allows a block that only touches an existing one', async () => {
    const { repository, service } = makeService();
    repository.findOverlapping.mockResolvedValue([]);

    await service.create(DOCTOR_ID, {
      startAt: '2026-09-06T09:00:00Z',
      endAt: '2026-09-06T10:00:00Z',
    });

    expect(repository.insert).toHaveBeenCalled();
  });
});

describe('BlocksService.remove', () => {
  it('throws NotFoundException when the block does not belong to that doctor', async () => {
    const { repository, service } = makeService();
    repository.findByIdForDoctor.mockResolvedValue(null);

    const error = await rejection(service.remove(DOCTOR_ID, BLOCK_ID));

    expect(error).toBeInstanceOf(NotFoundException);
    expect(repository.deleteById).not.toHaveBeenCalled();
  });

  it('deletes the row by id', async () => {
    const { repository, service } = makeService();
    repository.findByIdForDoctor.mockResolvedValue(blockRow());

    await service.remove(DOCTOR_ID, BLOCK_ID);

    expect(repository.deleteById).toHaveBeenCalledWith(BLOCK_ID);
  });
});
