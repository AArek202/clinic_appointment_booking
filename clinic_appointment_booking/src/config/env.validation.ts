import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { IsEnum, IsInt, IsString, MinLength, validateSync } from 'class-validator';
import { IsIanaTimeZone } from './is-iana-timezone.validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsInt()
  PORT: number = 3000;

  @IsString()
  DATABASE_URL!: string;

  @IsString()
  REDIS_URL!: string;

  @IsString()
  @MinLength(32, { message: 'JWT_SECRET must be at least 32 characters long' })
  JWT_SECRET!: string;

  @IsString()
  JWT_EXPIRES_IN: string = '1d';

  @IsIanaTimeZone()
  CLINIC_TZ!: string;
}

export function validateEnv(raw: Record<string, unknown>): EnvironmentVariables {
  const parsed = plainToInstance(EnvironmentVariables, raw, {
    enableImplicitConversion: true,
    exposeDefaultValues: true,
  });

  const errors = validateSync(parsed, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map((error) => `${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`)
      .join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${details}`);
  }

  return parsed;
}
