import { UserRole } from '../common/enums/role.enum';

export interface JwtPayload {
  /** users.id */
  sub: string;
  role: UserRole;
}
