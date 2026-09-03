import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Doctor } from '../doctors/doctor.entity';
import { Schedule } from './schedule.entity';

export interface NewSchedule {
  doctorId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  slotDurationMinutes: number;
}

@Injectable()
export class SchedulesRepository {
  constructor(
    @InjectRepository(Schedule)
    private readonly schedules: Repository<Schedule>,
    // Injected so this feature can answer "does that doctor exist?" without
    // depending on the DoctorsService method names, which the shared contract
    // does not fix. The Doctor entity and its id column are fixed.
    @InjectRepository(Doctor)
    private readonly doctors: Repository<Doctor>,
  ) {}

  async doctorExists(doctorId: string): Promise<boolean> {
    return (await this.doctors.countBy({ id: doctorId })) > 0;
  }

  /**
   * Every schedule row for a doctor, ordered so the API response and Plan 4's
   * slot generation both see a stable, human-readable order.
   */
  findByDoctorId(doctorId: string): Promise<Schedule[]> {
    return this.schedules.find({
      where: { doctorId },
      order: { dayOfWeek: 'ASC', startTime: 'ASC' },
    });
  }

  /** The rows a new or edited window has to be checked against. */
  findByDoctorAndDay(doctorId: string, dayOfWeek: number): Promise<Schedule[]> {
    return this.schedules.find({
      where: { doctorId, dayOfWeek },
      order: { startTime: 'ASC' },
    });
  }

  /**
   * Scoped by doctorId on purpose. An ADMIN calling
   * PATCH /doctors/<A>/schedules/<row belonging to B> must get 404, not silently
   * edit doctor B's schedule through doctor A's URL.
   */
  findByIdForDoctor(id: string, doctorId: string): Promise<Schedule | null> {
    return this.schedules.findOneBy({ id, doctorId });
  }

  insert(params: NewSchedule): Promise<Schedule> {
    return this.schedules.save(this.schedules.create(params));
  }

  /**
   * Writes the given row and nothing else. TypeORM's save() updates when the
   * entity carries an id. No cascade is configured on this entity, so an update
   * here can never touch appointments — which is the rule in
   * docs/FEATURES/Schedules.md about changing slot duration.
   */
  update(schedule: Schedule): Promise<Schedule> {
    return this.schedules.save(schedule);
  }

  async deleteById(id: string): Promise<void> {
    await this.schedules.delete({ id });
  }
}
