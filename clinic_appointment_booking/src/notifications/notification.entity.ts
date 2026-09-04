import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { NotificationStatus } from '../common/enums/notification-status.enum';
import { NotificationType } from '../common/enums/notification-type.enum';

@Entity('notifications')
@Index('notifications_unique_per_type', ['appointmentId', 'type'], {
  unique: true,
})
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'appointment_id', type: 'uuid' })
  appointmentId!: string;

  @Column({ name: 'patient_id', type: 'uuid' })
  patientId!: string;

  @Column({ type: 'text' })
  type!: NotificationType;

  @Column({ type: 'text', default: NotificationStatus.Pending })
  status!: NotificationStatus;

  @Column({ name: 'scheduled_at', type: 'timestamptz' })
  scheduledAt!: Date;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
