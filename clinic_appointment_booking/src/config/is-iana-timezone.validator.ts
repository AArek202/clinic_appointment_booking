import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { IANAZone } from 'luxon';

@ValidatorConstraint({ name: 'isIanaTimeZone', async: false })
export class IsIanaTimeZoneConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && IANAZone.isValidZone(value);
  }

  defaultMessage(): string {
    return 'CLINIC_TZ must be a valid IANA time zone name, for example Africa/Cairo';
  }
}

export function IsIanaTimeZone(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: IsIanaTimeZoneConstraint,
    });
  };
}
