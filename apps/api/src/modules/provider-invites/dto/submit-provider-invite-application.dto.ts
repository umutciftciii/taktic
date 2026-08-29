import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { IsKnownTurkishLocation } from '../../locations/turkish-location.validator';
import { ProviderServiceAreaDto } from '../../providers/dto/create-provider.dto';

/**
 * The application an invited business submits.
 *
 * Field for field the guest application form, with exactly one difference:
 * there is no `categoryIds`. The invitation names the service, the server reads
 * it from the stored row, and the client is never asked — because a client that
 * could name a category would be a client that decides which unreleased service
 * it is applying for. The global ValidationPipe runs with
 * `forbidNonWhitelisted`, so a body that invents the field is refused with a
 * 400 rather than quietly ignored.
 *
 * `token` is in the body rather than in the query string. The link carries it
 * in a path segment once, unavoidably; from the moment there is a form it
 * travels as a body field, so it never reaches a browser history entry, a
 * `Referer` header or an access log on the way to the API.
 *
 * The validators are the ones from CreateProviderDto, imported rather than
 * restated: `ProviderServiceAreaDto` is the same class the guest form posts, so
 * the province/district relation check cannot drift between the two forms.
 */
export class SubmitProviderInviteApplicationDto {
  @IsString()
  @IsNotEmpty()
  token!: string;

  @IsString()
  @IsNotEmpty()
  businessName!: string;

  @IsString()
  @IsNotEmpty()
  contactName!: string;

  @IsString()
  @IsNotEmpty()
  phone!: string;

  @IsOptional()
  @IsString()
  email?: string | null;

  @IsOptional()
  @IsString()
  taxType?: string | null;

  @IsOptional()
  @IsString()
  taxNumber?: string | null;

  @IsString()
  @IsNotEmpty()
  @IsKnownTurkishLocation()
  city!: string;

  @IsString()
  @IsNotEmpty()
  district!: string;

  @IsOptional()
  @IsString()
  addressNote?: string | null;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProviderServiceAreaDto)
  serviceAreas!: ProviderServiceAreaDto[];
}
