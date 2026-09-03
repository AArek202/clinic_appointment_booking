import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UserRole } from '../common/enums/role.enum';
import { DoctorsRepository } from '../doctors/doctors.repository';
import { PatientsRepository } from '../patients/patients.repository';
import { UsersRepository } from '../users/users.repository';
import { AuthUser } from './auth-user.interface';
import { JwtPayload } from './jwt-payload.interface';

@Injectable()
export class AuthUserResolver {
  constructor(
    private readonly users: UsersRepository,
    private readonly doctors: DoctorsRepository,
    private readonly patients: PatientsRepository,
  ) {}

  /**
   * Turns a verified token into the identity used for authorization.
   *
   * The profile ids are read from the database rather than the token, so a
   * token issued before a profile changed cannot assert stale ownership. The
   * role is also re-read, so revoking a role takes effect immediately instead
   * of when the token expires.
   */
  async resolve(payload: JwtPayload): Promise<AuthUser> {
    const user = await this.users.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }

    const authUser: AuthUser = { userId: user.id, role: user.role };

    if (user.role === UserRole.Doctor) {
      const doctor = await this.doctors.findByUserId(user.id);
      if (doctor) {
        authUser.doctorId = doctor.id;
      }
    }

    if (user.role === UserRole.Patient) {
      const patient = await this.patients.findByUserId(user.id);
      if (patient) {
        authUser.patientId = patient.id;
      }
    }

    return authUser;
  }
}
