import { UserRole } from '../common/enums/role.enum';

export interface AuthUser {
  userId: string;
  role: UserRole;
  /** Present when role is DOCTOR. */
  doctorId?: string;
  /** Present when role is PATIENT. */
  patientId?: string;
}
