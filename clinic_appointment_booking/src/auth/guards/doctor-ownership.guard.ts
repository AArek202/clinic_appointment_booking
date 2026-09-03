import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { UserRole } from '../../common/enums/role.enum';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { AuthUser } from '../auth-user.interface';

/**
 * Passes when the caller is an ADMIN, or is the doctor named by the
 * `:doctorId` route parameter.
 *
 * One rule, reused by schedules, blocks and analytics.
 */
@Injectable()
export class DoctorOwnershipGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthUser; params: Record<string, string> }>();

    const user = request.user;
    const doctorId = request.params.doctorId;

    if (user?.role === UserRole.Admin) {
      return true;
    }

    if (
      user?.role === UserRole.Doctor &&
      user.doctorId &&
      user.doctorId === doctorId
    ) {
      return true;
    }

    throw new AppException(
      ErrorCode.Forbidden,
      'You cannot act on this doctor',
      HttpStatus.FORBIDDEN,
    );
  }
}
