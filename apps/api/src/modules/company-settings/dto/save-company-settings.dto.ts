import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength, MinLength, NotEquals } from 'class-validator';
import {
  COMPANY_LEGAL_NAME_MAX_LENGTH,
  COMPANY_POSTAL_ADDRESS_MAX_LENGTH,
  COMPANY_SUPPORT_EMAIL_MAX_LENGTH,
  DEVELOPMENT_COMPANY_NAME,
  DEVELOPMENT_SUPPORT_EMAIL,
  EMAIL_ADDRESS_PATTERN,
} from '../company-settings.rules';

/**
 * The whole settings row, every time.
 *
 * A PUT rather than a PATCH: there are three fields, one screen edits all of
 * them, and a partial update would make "what does the footer say now?"
 * depend on which of several requests arrived last.
 */
export class SaveCompanySettingsDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2, { message: 'Yasal unvan en az 2 karakter olmalıdır.' })
  @MaxLength(COMPANY_LEGAL_NAME_MAX_LENGTH)
  @NotEquals(DEVELOPMENT_COMPANY_NAME, {
    message:
      'Yasal unvan ürün adı olamaz; e-posta altbilgisi göndereni tanımlar, ürünü değil.',
  })
  legalName!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @Matches(EMAIL_ADDRESS_PATTERN, { message: 'Destek e-postası geçerli bir adres olmalıdır.' })
  @MaxLength(COMPANY_SUPPORT_EMAIL_MAX_LENGTH)
  @NotEquals(DEVELOPMENT_SUPPORT_EMAIL, {
    message: 'Destek e-postası örnek/placeholder adres olamaz.',
  })
  supportEmail!: string;

  /**
   * Optional and normalised to null when blank, because "no address" is a real
   * answer: the footer drops the line rather than printing an invented street.
   */
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value ?? null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  })
  @IsString()
  @MaxLength(COMPANY_POSTAL_ADDRESS_MAX_LENGTH)
  postalAddress?: string | null;
}
