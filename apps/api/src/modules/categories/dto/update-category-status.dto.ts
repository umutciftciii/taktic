import { IsBoolean } from 'class-validator';

export class UpdateCategoryStatusDto {
  @IsBoolean()
  isActive!: boolean;
}
