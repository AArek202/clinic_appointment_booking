import { Injectable, NotFoundException } from '@nestjs/common';
import { BadRequestError, ConflictError } from '../common/errors/app.exception';
import { isConstraintViolation } from '../common/errors/database-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { Block } from './block.entity';
import { BlocksRepository } from './blocks.repository';
import { CreateBlockDto } from './dto/create-block.dto';

@Injectable()
export class BlocksService {
  constructor(private readonly repository: BlocksRepository) {}

  async listForDoctor(doctorId: string): Promise<Block[]> {
    await this.assertDoctorExists(doctorId);

    return this.repository.findByDoctorId(doctorId);
  }

  async create(doctorId: string, dto: CreateBlockDto): Promise<Block> {
    await this.assertDoctorExists(doctorId);

    // Parsing a client-supplied instant, not reading the current time. The
    // DTO's @IsISO8601 has already rejected anything unparseable, so these two
    // Dates are always valid. Nothing here needs the injected Clock: a block in
    // the past is legal, and recording that a doctor was away last week is a
    // reasonable thing to want.
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);

    if (endAt.getTime() <= startAt.getTime()) {
      throw new BadRequestError(
        ErrorCode.ValidationFailed,
        'endAt must be later than startAt',
      );
    }

    // One period of unavailability is one row (docs/DECISIONS.md #18). This
    // lookup is half-open, so a block that merely touches another is fine. The
    // invariant itself is blocks_no_overlap; this check exists to answer with a
    // readable 409 instead of a constraint violation.
    const overlapping = await this.repository.findOverlapping(
      doctorId,
      startAt,
      endAt,
    );
    if (overlapping.length > 0) {
      throw new ConflictError(
        ErrorCode.BlockOverlap,
        'This period overlaps an existing block for this doctor.',
      );
    }

    try {
      return await this.repository.insert({
        doctorId,
        startAt,
        endAt,
        reason: dto.reason ?? null,
      });
    } catch (error) {
      if (isConstraintViolation(error, 'blocks_no_overlap')) {
        throw new ConflictError(
          ErrorCode.BlockOverlap,
          'This period overlaps an existing block for this doctor.',
        );
      }
      throw error;
    }
  }

  async remove(doctorId: string, blockId: string): Promise<void> {
    const block = await this.repository.findByIdForDoctor(blockId, doctorId);

    if (!block) {
      throw new NotFoundException('Block not found');
    }

    await this.repository.deleteById(block.id);
  }

  private async assertDoctorExists(doctorId: string): Promise<void> {
    if (!(await this.repository.doctorExists(doctorId))) {
      throw new NotFoundException('Doctor not found');
    }
  }
}
