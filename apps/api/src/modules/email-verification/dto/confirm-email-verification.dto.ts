import { IsString, MinLength } from 'class-validator';

export class ConfirmEmailVerificationDto {
  @IsString()
  @MinLength(1)
  token!: string;
}
