import { IsString } from 'class-validator';

export class VerifyPhoneCodeDto {
  /**
   * Shape checking happens in the service so a malformed code produces exactly
   * the same response as a wrong one; a 400 from the validation pipe would
   * otherwise be distinguishable.
   */
  @IsString()
  code!: string;
}
