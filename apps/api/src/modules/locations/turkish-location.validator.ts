import {
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';
import { resolveArea } from './turkey-locations';

type LocationCarrier = {
  city?: unknown;
  district?: unknown;
  neighborhood?: unknown;
};

/**
 * Checks a province/district/neighbourhood triple as a *relation*, on the
 * server, whatever the browser sent.
 *
 * Both forms that name a place — the customer's request and the provider's
 * application — now offer cascading selects, so an impossible pair cannot be
 * composed by hand. That is a convenience, not a guarantee: both endpoints take
 * a plain JSON body, so "İstanbul / Çankaya" or a neighbourhood from a
 * different district has to be refused here or it would be stored. Provider
 * matching keys on city and district as text, which is exactly what a
 * fabricated pair would quietly break.
 *
 * Declared on `city` because that is the one field every carrier requires: a
 * request must name a district too, while a provider service area may name a
 * province alone and mean the whole of it. The rules the two share live in
 * {@link resolveArea}; "a request needs a district" stays where it belongs, on
 * the request DTO's own `@IsNotEmpty`.
 */
@ValidatorConstraint({ name: 'isKnownTurkishLocation', async: false })
export class IsKnownTurkishLocationConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as LocationCarrier;

    // An absent or non-string city is the business of @IsString and @IsNotEmpty
    // on that field; reporting it twice would be noise.
    if (typeof dto.city !== 'string' || !dto.city.trim()) {
      return true;
    }

    // Likewise a district or neighbourhood of the wrong type: those fields
    // carry their own @IsString, and this constraint has nothing to say about
    // a value that is not text.
    if (!isOptionalText(dto.district) || !isOptionalText(dto.neighborhood)) {
      return true;
    }

    return (
      resolveArea({
        city: dto.city,
        district: typeof dto.district === 'string' ? dto.district : null,
        neighborhood: typeof dto.neighborhood === 'string' ? dto.neighborhood : null,
      }) !== null
    );
  }

  defaultMessage(): string {
    return 'Seçilen il, ilçe ve mahalle birlikte geçerli bir adres oluşturmuyor.';
  }
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

export function IsKnownTurkishLocation(validationOptions?: ValidationOptions) {
  return function decorate(target: object, propertyName: string) {
    registerDecorator({
      target: target.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsKnownTurkishLocationConstraint,
    });
  };
}
