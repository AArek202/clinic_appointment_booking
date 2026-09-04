import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { WaitingListStatus } from '../common/enums/waiting-list-status.enum';

@Entity('waiting_list')
export class WaitingListEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'doctor_id', type: 'uuid' })
  doctorId!: string;

  @Column({ name: 'patient_id', type: 'uuid' })
  patientId!: string;

  @Column({ name: 'slot_start_at', type: 'timestamptz' })
  slotStartAt!: Date;

  /**
   * Stored rather than re-derived, because the schedule's slot duration may
   * have changed since the patient joined the queue.
   */
  @Column({ name: 'slot_end_at', type: 'timestamptz' })
  slotEndAt!: Date;

  @Column({ type: 'text' })
  status!: WaitingListStatus;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
