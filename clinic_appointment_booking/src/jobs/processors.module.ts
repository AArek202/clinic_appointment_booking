import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppointmentsModule } from '../appointments/appointments.module';
import { Appointment } from '../appointments/appointment.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { WaitingListModule } from '../waiting-list/waiting-list.module';
import { AppointmentReminderProcessor } from './appointment-reminder.processor';
import { JobsModule } from './jobs.module';
import { ReconcileScheduler } from './reconcile.scheduler';
import { ReconciliationProcessor } from './reconciliation.processor';
import { WaitingListProcessor } from './waiting-list.processor';
import {
  NoWaitingListReconciler,
  WaitingListReconciler,
} from './waiting-list-reconciler';

/**
 * The BullMQ processors. Imported by src/worker.module.ts only.
 *
 * If this module were imported by AppModule, scaling the API to two replicas
 * would double the worker pool as a side effect. See docs/DECISIONS.md #13.
 */
@Module({
  imports: [
    JobsModule,
    NotificationsModule,
    AppointmentsModule,
    WaitingListModule,
    TypeOrmModule.forFeature([Appointment]),
  ],
  providers: [
    AppointmentReminderProcessor,
    ReconciliationProcessor,
    ReconcileScheduler,
    WaitingListProcessor,
    // Plan 7 Task 6 replaces this binding with an adapter over WaitingListRepository.
    { provide: WaitingListReconciler, useClass: NoWaitingListReconciler },
  ],
})
export class ProcessorsModule {}
