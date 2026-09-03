/** Unique constraint violated. */
export const PG_UNIQUE_VIOLATION = '23505';

/** Exclusion constraint violated. */
export const PG_EXCLUSION_VIOLATION = '23P01';

/** Deadlock detected. Concurrent GiST exclusion checks can raise this. */
export const PG_DEADLOCK_DETECTED = '40P01';

interface DriverErrorShape {
  code?: string;
  constraint?: string;
}

function driverError(error: unknown): DriverErrorShape | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  // TypeORM wraps the pg error; some paths surface it directly.
  const candidate = (error as { driverError?: unknown }).driverError ?? error;
  if (typeof candidate !== 'object' || candidate === null) {
    return undefined;
  }

  return candidate as DriverErrorShape;
}

export function getSqlState(error: unknown): string | undefined {
  return driverError(error)?.code;
}

export function getConstraintName(error: unknown): string | undefined {
  return driverError(error)?.constraint;
}

/**
 * True when the error is a violation of the named constraint.
 *
 * Callers must use this rather than checking SQLSTATE alone:
 * appointments_no_overlap and appointments_patient_no_overlap both raise
 * 23P01 but mean different things. See docs/INFRASTRUCTURE/Concurrency.md.
 */
export function isConstraintViolation(
  error: unknown,
  constraint: string,
): boolean {
  const details = driverError(error);
  if (!details?.code) {
    return false;
  }

  const isViolation =
    details.code === PG_UNIQUE_VIOLATION ||
    details.code === PG_EXCLUSION_VIOLATION;

  return isViolation && details.constraint === constraint;
}

/** True when PostgreSQL aborted the statement because of a deadlock. */
export function isDeadlock(error: unknown): boolean {
  return getSqlState(error) === PG_DEADLOCK_DETECTED;
}
