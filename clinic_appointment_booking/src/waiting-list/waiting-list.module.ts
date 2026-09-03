import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppointmentsModule } from '../appointments/appointments.module';
import { SchedulesModule } from '../schedules/schedules.module';
import { WaitingListEntry } from './waiting-list-entry.entity';
import { WaitingListController } from './waiting-list.controller';
import { WaitingListRepository } from './waiting-list.repository';
import { WaitingListService } from './waiting-list.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([WaitingListEntry]),
    SchedulesModule,
    // One-directional only. AppointmentsModule must never import this module.
    AppointmentsModule,
  ],
  controllers: [WaitingListController],
  providers: [WaitingListRepository, WaitingListService],
  exports: [WaitingListRepository, WaitingListService],
})
export class WaitingListModule {}
