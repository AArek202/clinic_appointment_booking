import { HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { UserRole } from '../common/enums/role.enum';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-code.enum';
import { PatientsRepository } from '../patients/patients.repository';
import { UsersRepository } from '../users/users.repository';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtPayload } from './jwt-payload.interface';
import { PasswordService } from './password.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersRepository,
    private readonly patients: PatientsRepository,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
    private readonly dataSource: DataSource,
  ) {}

  async register(
    dto: RegisterDto,
  ): Promise<{ id: string; email: string; role: UserRole }> {
    const existing = await this.users.findByEmail(dto.email);
    if (existing) {
      throw new AppException(
        ErrorCode.EmailAlreadyRegistered,
        'An account with this email already exists.',
        HttpStatus.CONFLICT,
      );
    }

    const passwordHash = await this.passwords.hash(dto.password);

    // The user row and the patient profile must appear together or not at all.
    const user = await this.dataSource.transaction(async (manager) => {
      const created = await this.users.createUser(
        {
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email,
          passwordHash,
          // Role is set here, never taken from the request.
          role: UserRole.Patient,
        },
        manager,
      );

      await this.patients.createPatient(
        {
          userId: created.id,
          phoneNumber: dto.phoneNumber ?? null,
          dateOfBirth: dto.dateOfBirth ?? null,
          gender: dto.gender ?? null,
        },
        manager,
      );

      return created;
    });

    return { id: user.id, email: user.email, role: user.role };
  }

  async login(dto: LoginDto): Promise<{ accessToken: string }> {
    const user = await this.users.findByEmail(dto.email);

    // Same response for unknown email and wrong password, so the endpoint
    // cannot be used to enumerate registered accounts.
    const valid = user
      ? await this.passwords.verify(dto.password, user.passwordHash)
      : false;
    if (!user || !valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const payload: JwtPayload = { sub: user.id, role: user.role };
    return { accessToken: await this.jwt.signAsync(payload) };
  }
}
