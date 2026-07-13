import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { normalizeE164 } from '../utils/phone.util';

export function IsE164Phone(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isE164Phone',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && normalizeE164(value) !== null;
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} gecerli bir E.164 telefon numarasi olmalidir (ornek: +905551234567).`;
        },
      },
    });
  };
}
