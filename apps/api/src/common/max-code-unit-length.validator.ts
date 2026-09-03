import {
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';

/**
 * A maximum string length counted in UTF-16 code units — JavaScript's own
 * `string.length`.
 *
 * `@MaxLength` deliberately does not do this: it goes through validator.js,
 * which strips surrogate pairs first and so counts *code points*. The two agree
 * for ordinary Turkish prose and diverge the moment an emoji appears — 2501
 * emoji are 2501 code points but 5002 code units, and `@MaxLength(5000)` lets
 * them through.
 *
 * That divergence matters here because the number is also shown to the customer
 * while they type. A textarea's `maxLength` is defined on the code-unit length,
 * and so is the counter beside it, so a limit enforced in code points would let
 * the browser stop someone the server would have accepted — and, worse, accept
 * text the counter had already reported as over the line. Counting the same
 * unit on both sides is what keeps the promise on screen true.
 */
@ValidatorConstraint({ name: 'maxCodeUnitLength', async: false })
export class MaxCodeUnitLengthConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    // A non-string is @IsString's business; saying so twice would be noise.
    if (typeof value !== 'string') {
      return true;
    }

    const [max] = args.constraints as [number];
    return value.length <= max;
  }

  defaultMessage(args: ValidationArguments): string {
    const [max] = args.constraints as [number];
    return `${args.property} en fazla ${max} karakter olabilir.`;
  }
}

export function MaxCodeUnitLength(max: number, validationOptions?: ValidationOptions) {
  return function decorate(target: object, propertyName: string) {
    registerDecorator({
      target: target.constructor,
      propertyName,
      options: validationOptions,
      constraints: [max],
      validator: MaxCodeUnitLengthConstraint,
    });
  };
}
