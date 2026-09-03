import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * A period during which a doctor is unavailable: a vacation day, an emergency.
 *
 * Unlike Schedule, a block is an absolute instant range (timestamptz), because
 * it names a specific moment in the calendar rather than a recurring weekly
 * window. Slot generation compares blocks against slot boundaries that have
 * already been converted to UTC, so both sides are absolute and no timezone
 * arithmetic happens here. See docs/DATABASE.md, "Timezone Strategy".
 */
@Entity('blocks')
export class Block {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'doctor_id', type: 'uuid' })
  doctorId: string;

  @Column({ name: 'start_at', type: 'timestamptz' })
  startAt: Date;

  @Column({ name: 'end_at', type: 'timestamptz' })
  endAt: Date;

  @Column({ type: 'text', nullable: true })
  reason: string | null;
}
