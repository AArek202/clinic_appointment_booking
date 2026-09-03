import {
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../users/user.entity';

@Entity('doctors')
export class Doctor {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid', unique: true })
  userId!: string;

  @Column({ type: 'text' })
  specialization!: string;

  @Column({ type: 'text', nullable: true })
  achievements!: string | null;

  @OneToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user?: User;
}
