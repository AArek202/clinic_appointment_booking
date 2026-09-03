import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * A doctor's recurring weekly working window.
 *
 * dayOfWeek is 0 = Sunday .. 6 = Saturday, matching PostgreSQL
 * EXTRACT(DOW FROM date). See docs/DATABASE.md.
 *
 * startTime and endTime are wall-clock times in the clinic's timezone with no
 * offset attached. They become absolute instants only during schedule
 * expansion (Plan 4), which is the single place the conversion happens.
 *
 * There is deliberately no ManyToOne relation to Doctor. Nothing in this
 * feature joins to the doctor, and the foreign key is enforced by the
 * migration. `docs/PLANS/00-interfaces.md` lists exactly these six properties.
 */
@Entity('schedules')
export class Schedule {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'doctor_id', type: 'uuid' })
  doctorId: string;

  @Column({ name: 'day_of_week', type: 'smallint' })
  dayOfWeek: number;

  // The pg driver returns a `time` column as a 'HH:mm:ss' string, which is
  // exactly the TypeScript representation the shared contract asks for.
  @Column({ name: 'start_time', type: 'time' })
  startTime: string;

  @Column({ name: 'end_time', type: 'time' })
  endTime: string;

  @Column({ name: 'slot_duration_minutes', type: 'smallint' })
  slotDurationMinutes: number;
}
