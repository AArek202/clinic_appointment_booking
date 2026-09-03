import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Patient } from './patient.entity';

export interface CreatePatientParams {
  userId: string;
  phoneNumber?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
}

@Injectable()
export class PatientsRepository {
  constructor(
    @InjectRepository(Patient) private readonly repo: Repository<Patient>,
  ) {}

  findById(id: string): Promise<Patient | null> {
    return this.repo.findOne({ where: { id } });
  }

  findByUserId(userId: string): Promise<Patient | null> {
    return this.repo.findOne({ where: { userId } });
  }

  createPatient(
    params: CreatePatientParams,
    manager?: EntityManager,
  ): Promise<Patient> {
    const repo = manager ? manager.getRepository(Patient) : this.repo;
    return repo.save(
      repo.create({
        phoneNumber: null,
        dateOfBirth: null,
        gender: null,
        ...params,
      }),
    );
  }
}
