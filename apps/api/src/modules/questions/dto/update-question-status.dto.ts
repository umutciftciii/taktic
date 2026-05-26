import { IsBoolean } from 'class-validator';

export class UpdateQuestionStatusDto {
  @IsBoolean()
  isActive!: boolean;
}
