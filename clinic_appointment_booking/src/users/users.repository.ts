import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { UserRole } from '../common/enums/role.enum';
import { User } from './user.entity';

export interface CreateUserParams {
  firstName: string;
  lastName: string;
  email: string;
  passwordHash: string;
  role: UserRole;
}

@Injectable()
export class UsersRepository {
  constructor(
    @InjectRepository(User) private readonly repo: Repository<User>,
  ) {}

  findByEmail(email: string): Promise<User | null> {
    return this.repo.findOne({ where: { email: email.trim().toLowerCase() } });
  }

  findById(id: string): Promise<User | null> {
    return this.repo.findOne({ where: { id } });
  }

  createUser(params: CreateUserParams, manager?: EntityManager): Promise<User> {
    const repo = manager ? manager.getRepository(User) : this.repo;
    return repo.save(
      repo.create({ ...params, email: params.email.trim().toLowerCase() }),
    );
  }
}
