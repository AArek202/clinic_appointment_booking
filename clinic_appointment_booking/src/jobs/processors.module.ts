import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Appointment } from '../appointments/appointment.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { AppointmentReminderProcessor } from './appointment-reminder.processor';
import { JobsModule } from './jobs.module';
import { ReconcileScheduler } from './reconcile.scheduler';
import { ReconciliationProcessor } from './reconciliation.processor';
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
    // Entity-level dependency only. Plan 7 adds AppointmentsModule and
    // WaitingListModule here.
    TypeOrmModule.forFeature([Appointment]),
  ],
  providers: [
    AppointmentReminderProcessor,
    ReconciliationProcessor,
    ReconcileScheduler,
    // Plan 7 replaces this binding with an adapter over WaitingListService.
    { provide: WaitingListReconciler, useClass: NoWaitingListReconciler },
  ],
})
export class ProcessorsModule {}
