import { QueryFailedError } from 'typeorm';
import {
  getConstraintName,
  getSqlState,
  isConstraintViolation,
  isDeadlock,
  PG_DEADLOCK_DETECTED,
  PG_EXCLUSION_VIOLATION,
} from './database-error';

/** Shape of a real pg driver error, as TypeORM wraps it. */
function pgError(code: string, constraint: string): QueryFailedError {
  const driverError = Object.assign(new Error('conflicting key value'), {
    code,
    constraint,
  });
  return new QueryFailedError('INSERT ...', [], driverError);
}

describe('database error helpers', () => {
  it('extracts the SQLSTATE', () => {
    expect(getSqlState(pgError('23P01', 'appointments_no_overlap'))).toBe(
      '23P01',
    );
  });

  it('extracts the constraint name', () => {
    expect(getConstraintName(pgError('23P01', 'appointments_no_overlap'))).toBe(
      'appointments_no_overlap',
    );
  });

  it('matches a specific constraint', () => {
    const error = pgError(PG_EXCLUSION_VIOLATION, 'appointments_no_overlap');

    expect(isConstraintViolation(error, 'appointments_no_overlap')).toBe(true);
  });

  it('does not confuse the two appointment exclusion constraints', () => {
    const patientConflict = pgError(
      PG_EXCLUSION_VIOLATION,
      'appointments_patient_no_overlap',
    );

    expect(
      isConstraintViolation(patientConflict, 'appointments_no_overlap'),
    ).toBe(false);
    expect(
      isConstraintViolation(patientConflict, 'appointments_patient_no_overlap'),
    ).toBe(true);
  });

  it('returns undefined for a non-database error', () => {
    expect(getSqlState(new Error('nope'))).toBeUndefined();
    expect(getConstraintName(new Error('nope'))).toBeUndefined();
  });

  it('detects a deadlock and does not treat it as a constraint violation', () => {
    const deadlock = pgError(PG_DEADLOCK_DETECTED, '');

    expect(isDeadlock(deadlock)).toBe(true);
    expect(
      isDeadlock(pgError(PG_EXCLUSION_VIOLATION, 'appointments_no_overlap')),
    ).toBe(false);
    expect(isConstraintViolation(deadlock, 'appointments_no_overlap')).toBe(
      false,
    );
  });
});
