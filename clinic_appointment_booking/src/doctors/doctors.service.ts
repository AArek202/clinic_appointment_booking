import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PasswordService } from '../auth/password.service';
import { UserRole } from '../common/enums/role.enum';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-code.enum';
import { UsersRepository } from '../users/users.repository';
import { Doctor } from './doctor.entity';
import { DoctorsRepository } from './doctors.repository';
import { CreateDoctorDto } from './dto/create-doctor.dto';

@Injectable()
export class DoctorsService {
  constructor(
    private readonly doctors: DoctorsRepository,
    private readonly users: UsersRepository,
    private readonly passwords: PasswordService,
    private readonly dataSource: DataSource,
  ) {}

  async createDoctor(dto: CreateDoctorDto): Promise<Doctor> {
    const existing = await this.users.findByEmail(dto.email);
    if (existing) {
      throw new AppException(
        ErrorCode.EmailAlreadyRegistered,
        'An account with this email already exists.',
        HttpStatus.CONFLICT,
      );
    }

    const passwordHash = await this.passwords.hash(dto.password);

    // A doctor without a user account cannot log in, and a DOCTOR user without
    // a profile cannot own a schedule. Both rows commit together or neither does.
    return this.dataSource.transaction(async (manager) => {
      const user = await this.users.createUser(
        {
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email,
          passwordHash,
          role: UserRole.Doctor,
        },
        manager,
      );

      return this.doctors.createDoctor(
        {
          userId: user.id,
          specialization: dto.specialization,
          achievements: dto.achievements ?? null,
        },
        manager,
      );
    });
  }

  async findAll(): Promise<Doctor[]> {
    return this.doctors.findAll();
  }

  async findById(id: string): Promise<Doctor> {
    const doctor = await this.doctors.findById(id);
    if (!doctor) {
      throw new NotFoundException('Doctor not found');
    }
    return doctor;
  }
}
