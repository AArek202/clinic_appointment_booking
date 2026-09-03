import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Appointment } from '../appointments/appointment.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { AppointmentReminderProcessor } from './appointment-reminder.processor';
import { JobsModule } from './jobs.module';

/**
 * The BullMQ processors. Imported by src/worker.module.ts only.
 *
 * If this module were imported by AppModule, scaling the API to two replicas
 * would double the worker pool as a side effect — a change to request capacity
 * quietly changing job concurrency. See docs/DECISIONS.md #13.
 */
@Module({
  imports: [
    JobsModule,
    NotificationsModule,
    // Entity-level dependency only. Plan 7 adds AppointmentsModule here for
    // AppointmentsService.createFromWaitingList.
    TypeOrmModule.forFeature([Appointment]),
  ],
  providers: [AppointmentReminderProcessor],
})
export class ProcessorsModule {}
