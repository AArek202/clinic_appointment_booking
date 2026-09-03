import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, MoreThan, Repository } from 'typeorm';
import { Doctor } from '../doctors/doctor.entity';
import { Block } from './block.entity';

export interface NewBlock {
  doctorId: string;
  startAt: Date;
  endAt: Date;
  reason: string | null;
}

@Injectable()
export class BlocksRepository {
  constructor(
    @InjectRepository(Block)
    private readonly blocks: Repository<Block>,
    @InjectRepository(Doctor)
    private readonly doctors: Repository<Doctor>,
  ) {}

  async doctorExists(doctorId: string): Promise<boolean> {
    return (await this.doctors.countBy({ id: doctorId })) > 0;
  }

  findByDoctorId(doctorId: string): Promise<Block[]> {
    return this.blocks.find({ where: { doctorId }, order: { startAt: 'ASC' } });
  }

  /** Scoped by doctorId so one doctor's URL cannot reach another's row. */
  findByIdForDoctor(id: string, doctorId: string): Promise<Block | null> {
    return this.blocks.findOneBy({ id, doctorId });
  }

  /**
   * Blocks that intersect the half-open range [startAt, endAt).
   *
   * A block ending exactly at startAt, or starting exactly at endAt, does not
   * intersect. This matches the '[)' bound used by appointments_no_overlap
   * (docs/DATABASE.md) — a block that ends at 10:00 must not remove the slot
   * that begins at 10:00.
   *
   * Uses the blocks_doctor_id_start_at_end_at_idx index. Consumed by Plan 4's
   * availability listing and Plan 5's SLOT_BLOCKED check.
   */
  findOverlapping(
    doctorId: string,
    startAt: Date,
    endAt: Date,
  ): Promise<Block[]> {
    return this.blocks.find({
      where: { doctorId, startAt: LessThan(endAt), endAt: MoreThan(startAt) },
      order: { startAt: 'ASC' },
    });
  }

  insert(params: NewBlock): Promise<Block> {
    return this.blocks.save(this.blocks.create(params));
  }

  async deleteById(id: string): Promise<void> {
    await this.blocks.delete({ id });
  }
}
