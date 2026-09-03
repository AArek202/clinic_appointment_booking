import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AppointmentSource } from '../common/enums/appointment-source.enum';
import { AppointmentStatus } from '../common/enums/appointment-status.enum';
import { Appointment } from './appointment.entity';

export interface InsertConfirmedParams {
  doctorId: string;
  patientId: string;
  startAt: Date;
  endAt: Date;
  createdFrom: AppointmentSource;
}

export interface BookedRange {
  startAt: Date;
  endAt: Date;
}

@Injectable()
export class AppointmentsRepository {
  constructor(
    @InjectRepository(Appointment)
    private readonly repo: Repository<Appointment>,
  ) {}

  /**
   * Inserts a CONFIRMED appointment.
   *
   * Deliberately does NOT catch constraint violations: callers must branch on
   * the constraint name, and swallowing the error here would destroy that
   * information.
   */
  insertConfirmed(
    params: InsertConfirmedParams,
    manager?: EntityManager,
  ): Promise<Appointment> {
    const repo = manager ? manager.getRepository(Appointment) : this.repo;
    return repo.save(
      repo.create({
        ...params,
        status: AppointmentStatus.Confirmed,
        cancelledAt: null,
      }),
    );
  }

  findById(id: string): Promise<Appointment | null> {
    return this.repo.findOne({ where: { id } });
  }

  /**
   * Conditional cancel. Returns the number of rows affected: 0 means it was
   * already cancelled, which makes a retried cancel request safe.
   */
  async cancelIfConfirmed(id: string, cancelledAt: Date): Promise<number> {
    const result = await this.repo
      .createQueryBuilder()
      .update(Appointment)
      .set({ status: AppointmentStatus.Cancelled, cancelledAt })
      .where('id = :id AND status = :status', {
        id,
        status: AppointmentStatus.Confirmed,
      })
      .execute();

    return result.affected ?? 0;
  }

  /** Pre-check for a friendly error. The constraint is the real guarantee. */
  findOverlappingForPatient(
    patientId: string,
    startAt: Date,
    endAt: Date,
    manager?: EntityManager,
  ): Promise<Appointment | null> {
    const repo = manager ? manager.getRepository(Appointment) : this.repo;
    return repo
      .createQueryBuilder('a')
      .where('a.patient_id = :patientId', { patientId })
      .andWhere('a.status = :status', { status: AppointmentStatus.Confirmed })
      .andWhere('a.start_at < :endAt AND a.end_at > :startAt', {
        startAt,
        endAt,
      })
      .getOne();
  }

  /**
   * Confirmed appointments overlapping the window, for availability listing.
   * Served by the appointments_no_overlap GiST index.
   */
  async findBookedRanges(
    doctorId: string,
    fromAt: Date,
    toAt: Date,
  ): Promise<BookedRange[]> {
    return this.repo
      .createQueryBuilder('a')
      .select(['a.start_at AS "startAt"', 'a.end_at AS "endAt"'])
      .where('a.doctor_id = :doctorId', { doctorId })
      .andWhere('a.status = :status', { status: AppointmentStatus.Confirmed })
      .andWhere('a.start_at < :toAt AND a.end_at > :fromAt', { fromAt, toAt })
      .orderBy('a.start_at', 'ASC')
      .getRawMany<BookedRange>();
  }

  listForPatient(patientId: string): Promise<Appointment[]> {
    return this.repo.find({ where: { patientId }, order: { startAt: 'DESC' } });
  }

  listForDoctor(doctorId: string): Promise<Appointment[]> {
    return this.repo.find({ where: { doctorId }, order: { startAt: 'ASC' } });
  }
}
