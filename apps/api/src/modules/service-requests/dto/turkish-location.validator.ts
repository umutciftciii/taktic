import {
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';
import { resolveLocation } from '../../locations/turkey-locations';

type LocationCarrier = {
  city?: unknown;
  district?: unknown;
  neighborhood?: unknown;
};

/**
 * Checks the province/district/neighbourhood triple as a *relation*, on the
 * server, whatever the browser sent.
 *
 * The form now offers cascading selects, so a customer cannot compose an
 * impossible pair by hand. That is a convenience, not a guarantee: the request
 * endpoint is public and accepts a plain JSON body, so "İstanbul / Çankaya" or
 * a neighbourhood from a different district has to be refused here or it would
 * be stored. Provider matching keys on city and district, which is what a
 * fabricated pair would quietly break.
 *
 * Declared on the class rather than on one property because no single field is
 * wrong on its own — the three only make sense read together.
 */
@ValidatorConstraint({ name: 'isKnownTurkishLocation', async: false })
export class IsKnownTurkishLocationConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as LocationCarrier;

    // Absent or non-string city/district are the business of @IsString and
    // @IsNotEmpty on those fields; reporting them twice would be noise.
    if (typeof dto.city !== 'string' || typeof dto.district !== 'string') {
      return true;
    }
    if (!dto.city.trim() || !dto.district.trim()) {
      return true;
    }
    if (dto.neighborhood !== undefined && dto.neighborhood !== null && typeof dto.neighborhood !== 'string') {
      return true;
    }

    return (
      resolveLocation({
        city: dto.city,
        district: dto.district,
        neighborhood: typeof dto.neighborhood === 'string' ? dto.neighborhood : null,
      }) !== null
    );
  }

  defaultMessage(): string {
    return 'Seçilen il, ilçe ve mahalle birlikte geçerli bir adres oluşturmuyor.';
  }
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
