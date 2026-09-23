import { IsOptional, IsString, MaxLength } from 'class-validator';

/** The provider's own declaration. Validated as a pair by `requireValidBusinessRegistration`. */
export class UpdateBusinessRegistrationDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  type?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  number?: string | null;
}
