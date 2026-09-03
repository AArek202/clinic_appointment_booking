import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserRole } from '../common/enums/role.enum';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'first_name', type: 'text' })
  firstName!: string;

  @Column({ name: 'last_name', type: 'text' })
  lastName!: string;

  /** Always stored lowercased so uniqueness is case-insensitive. */
  @Column({ type: 'text', unique: true })
  email!: string;

  @Column({ name: 'password_hash', type: 'text' })
  passwordHash!: string;

  @Column({ type: 'text' })
  role!: UserRole;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
