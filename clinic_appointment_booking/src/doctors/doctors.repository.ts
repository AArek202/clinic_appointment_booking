import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Doctor } from './doctor.entity';

export interface CreateDoctorParams {
  userId: string;
  specialization: string;
  achievements?: string | null;
}

@Injectable()
export class DoctorsRepository {
  constructor(@InjectRepository(Doctor) private readonly repo: Repository<Doctor>) {}

  findById(id: string): Promise<Doctor | null> {
    return this.repo.findOne({ where: { id } });
  }

  findByUserId(userId: string): Promise<Doctor | null> {
    return this.repo.findOne({ where: { userId } });
  }

  findAll(): Promise<Doctor[]> {
    return this.repo.find({ relations: { user: true }, order: { id: 'ASC' } });
  }

  createDoctor(params: CreateDoctorParams, manager?: EntityManager): Promise<Doctor> {
    const repo = manager ? manager.getRepository(Doctor) : this.repo;
    return repo.save(repo.create({ achievements: null, ...params }));
  }
}
