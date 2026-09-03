import { Module } from '@nestjs/common';
import { BlocksModule } from '../blocks/blocks.module';
import { SchedulesModule } from '../schedules/schedules.module';
import { AvailabilityController } from './availability.controller';
import { AvailabilityRepository } from './availability.repository';
import { AvailabilityService } from './availability.service';

@Module({
  imports: [SchedulesModule, BlocksModule],
  controllers: [AvailabilityController],
  providers: [AvailabilityRepository, AvailabilityService],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
