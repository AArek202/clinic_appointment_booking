import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Appointment } from '../appointments/appointment.entity';
import { AppointmentStatus } from '../common/enums/appointment-status.enum';
import { NotificationStatus } from '../common/enums/notification-status.enum';
import { NotificationType } from '../common/enums/notification-type.enum';
import { Notification } from './notification.entity';

@Injectable()
export class NotificationsRepository {
  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
  ) {}

  /**
   * Writes the PENDING intent using the caller's EntityManager, so the row
   * commits and rolls back with the business transaction that created it.
   * The row — not the BullMQ job — is the source of truth.
   */
  async createPending(
    manager: EntityManager,
    params: {
      appointmentId: string;
      patientId: string;
      type: NotificationType;
      scheduledAt: Date;
    },
  ): Promise<Notification> {
    const notification = manager.create(Notification, {
      appointmentId: params.appointmentId,
      patientId: params.patientId,
      type: params.type,
      status: NotificationStatus.Pending,
      scheduledAt: params.scheduledAt,
      sentAt: null,
    });

    return manager.save(notification);
  }

  /**
   * Atomically transitions PENDING -> SENT.
   *
   * Returns false when no row was affected, meaning another worker already
   * sent it. Callers must exit successfully on false, never retry.
   *
   * One statement with the precondition in the WHERE clause. Reading the
   * status and then writing it would be a race between two workers: both
   * would read PENDING and both would send.
   */
  async markSentIfPending(
    appointmentId: string,
    type: NotificationType,
  ): Promise<boolean> {
    const result: unknown = await this.notifications.manager.query(
      `UPDATE notifications
          SET status = 'SENT', sent_at = now()
        WHERE appointment_id = $1
          AND type = $2
          AND status = 'PENDING'
       RETURNING id`,
      [appointmentId, type],
    );

    // TypeORM's Postgres driver returns [rows, affectedCount] for UPDATE and
    // DELETE, but a bare rows array for everything else. Normalise both so a
    // driver upgrade cannot silently turn this into "always true".
    const rows = Array.isArray((result as unknown[])[0])
      ? ((result as unknown[])[0] as unknown[])
      : (result as unknown[]);

    return rows.length > 0;
  }

  /**
   * Notifications that are still PENDING, are due, and whose appointment is
   * still CONFIRMED. Used only by the reconciliation sweeper: this is the
   * database's own description of work that was committed but never delivered.
   */
  async findDuePending(now: Date, limit: number): Promise<Notification[]> {
    return this.notifications
      .createQueryBuilder('notification')
      .innerJoin(
        Appointment,
        'appointment',
        'appointment.id = notification.appointmentId',
      )
      .where('notification.status = :pending', {
        pending: NotificationStatus.Pending,
      })
      .andWhere('notification.scheduledAt <= :now', { now })
      .andWhere('appointment.status = :confirmed', {
        confirmed: AppointmentStatus.Confirmed,
      })
      .orderBy('notification.scheduledAt', 'ASC')
      .limit(limit)
      .getMany();
  }
}
