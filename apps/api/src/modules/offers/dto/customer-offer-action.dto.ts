import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class CustomerOfferActionDto {
  @IsIn(['SHORTLIST', 'REJECT', 'ACCEPT'])
  action!: 'SHORTLIST' | 'REJECT' | 'ACCEPT';

  /**
   * The customer's confirmation, given at the accept screen, that they have read
   * the contact-sharing disclosure.
   *
   * Optional on the DTO and mandatory in the rule: only ACCEPT consults it, and
   * only while contact sharing is on. It is not a way to opt *out* — a false or
   * absent value on an accept that needs one refuses the accept rather than
   * matching without sharing, because a match that shares nothing is not a
   * product state this platform has.
   */
  @IsOptional()
  @IsBoolean()
  contactDisclosureAccepted?: boolean;

  /**
   * Which version of the text the screen actually showed.
   *
   * Compared against configuration and never stored from here: a client that
   * confirms a superseded wording is asked again rather than having its answer
   * recorded against the current one.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  contactDisclosureVersion?: string;
}
