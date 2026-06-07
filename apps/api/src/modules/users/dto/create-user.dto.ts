import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

function trimOrPass(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.trim();
}

function lowerOrPass(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.trim().toLowerCase();
}

export class CreateUserDto {
  @Transform(({ value }) => trimOrPass(value))
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @Transform(({ value }) => lowerOrPass(value))
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @Transform(({ value }) => trimOrPass(value))
  @IsString()
  @MaxLength(32)
  phone?: string;
}
