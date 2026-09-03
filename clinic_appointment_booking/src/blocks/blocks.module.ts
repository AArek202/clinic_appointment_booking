import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Doctor } from '../doctors/doctor.entity';
import { Block } from './block.entity';
import { BlocksController } from './blocks.controller';
import { BlocksRepository } from './blocks.repository';
import { BlocksService } from './blocks.service';

@Module({
  imports: [TypeOrmModule.forFeature([Block, Doctor])],
  controllers: [BlocksController],
  providers: [BlocksRepository, BlocksService],
  // Exported for Plan 4 (subtracting blocks from generated slots) and Plan 5
  // (the SLOT_BLOCKED check before booking).
  exports: [BlocksRepository],
})
export class BlocksModule {}
