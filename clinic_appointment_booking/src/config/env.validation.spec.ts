import { validateEnv } from './env.validation';

const valid = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgres://clinic:clinic@localhost:5432/clinic',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a'.repeat(32),
  JWT_EXPIRES_IN: '1d',
  CLINIC_TZ: 'Africa/Cairo',
};

describe('validateEnv', () => {
  it('accepts a complete, valid environment', () => {
    const result = validateEnv(valid);
    expect(result.CLINIC_TZ).toBe('Africa/Cairo');
  });

  it('coerces PORT to a number', () => {
    expect(validateEnv(valid).PORT).toBe(3000);
  });

  it('rejects a missing DATABASE_URL', () => {
    const { DATABASE_URL, ...withoutDb } = valid;
    expect(() => validateEnv(withoutDb)).toThrow(/DATABASE_URL/);
  });

  it('rejects a JWT_SECRET shorter than 32 characters', () => {
    expect(() => validateEnv({ ...valid, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('rejects a CLINIC_TZ that is not a real IANA zone', () => {
    expect(() => validateEnv({ ...valid, CLINIC_TZ: 'Mars/Olympus' })).toThrow(
      /CLINIC_TZ/,
    );
  });

  it('accepts UTC as a CLINIC_TZ', () => {
    expect(validateEnv({ ...valid, CLINIC_TZ: 'UTC' }).CLINIC_TZ).toBe('UTC');
  });
});
