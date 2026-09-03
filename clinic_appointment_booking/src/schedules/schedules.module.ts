import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Doctor } from '../doctors/doctor.entity';
import { Schedule } from './schedule.entity';
import { SchedulesController } from './schedules.controller';
import { SchedulesRepository } from './schedules.repository';
import { SchedulesService } from './schedules.service';

@Module({
  // Doctor is registered here so SchedulesRepository can answer
  // "does that doctor exist?" without importing Plan 2's service.
  imports: [TypeOrmModule.forFeature([Schedule, Doctor])],
  controllers: [SchedulesController],
  providers: [SchedulesRepository, SchedulesService],
  // Exported for Plan 4: AvailabilityModule reads schedule rows to expand slots.
  exports: [SchedulesRepository],
})
export class SchedulesModule {}
