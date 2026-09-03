import { ExecutionContext } from '@nestjs/common';
import { UserRole } from '../../common/enums/role.enum';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { AuthUser } from '../auth-user.interface';
import { DoctorOwnershipGuard } from './doctor-ownership.guard';

function contextFor(user: AuthUser | undefined, doctorId: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user, params: { doctorId } }) }),
  } as unknown as ExecutionContext;
}

describe('DoctorOwnershipGuard', () => {
  const guard = new DoctorOwnershipGuard();
  const doctorA = 'aaaaaaaa-0000-0000-0000-000000000001';
  const doctorB = 'bbbbbbbb-0000-0000-0000-000000000002';

  it('allows an admin to act on any doctor', () => {
    const user: AuthUser = { userId: 'u1', role: UserRole.Admin };

    expect(guard.canActivate(contextFor(user, doctorA))).toBe(true);
  });

  it('allows a doctor to act on their own record', () => {
    const user: AuthUser = { userId: 'u2', role: UserRole.Doctor, doctorId: doctorA };

    expect(guard.canActivate(contextFor(user, doctorA))).toBe(true);
  });

  it("forbids a doctor acting on another doctor's record", () => {
    const user: AuthUser = { userId: 'u3', role: UserRole.Doctor, doctorId: doctorB };

    expect(() => guard.canActivate(contextFor(user, doctorA))).toThrow(AppException);
    expect(() => guard.canActivate(contextFor(user, doctorA))).toThrow(
      expect.objectContaining({ code: ErrorCode.Forbidden }),
    );
  });

  it('forbids a patient', () => {
    const user: AuthUser = { userId: 'u4', role: UserRole.Patient, patientId: 'p1' };

    expect(() => guard.canActivate(contextFor(user, doctorA))).toThrow(AppException);
  });

  it('forbids a doctor with no linked profile', () => {
    const user: AuthUser = { userId: 'u5', role: UserRole.Doctor };

    expect(() => guard.canActivate(contextFor(user, doctorA))).toThrow(AppException);
  });
});
