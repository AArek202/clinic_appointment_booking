import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Appointment } from '../appointments/appointment.entity';
import { Notification } from './notification.entity';
import { NotificationsRepository } from './notifications.repository';

@Module({
  // Appointment is registered here too because findDuePending joins it. It is
  // an entity-level dependency only; this module never imports
  // AppointmentsModule.
  imports: [TypeOrmModule.forFeature([Notification, Appointment])],
  providers: [NotificationsRepository],
  exports: [NotificationsRepository],
})
export class NotificationsModule {}
