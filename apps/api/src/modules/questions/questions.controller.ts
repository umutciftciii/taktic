import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CreateQuestionDto } from './dto/create-question.dto';
import { UpdateQuestionStatusDto } from './dto/update-question-status.dto';
import { UpdateQuestionDto } from './dto/update-question.dto';
import { QuestionsService } from './questions.service';

@Controller()
export class QuestionsController {
  constructor(@Inject(QuestionsService) private readonly questionsService: QuestionsService) {}

  @Get('categories/:categoryId/questions')
  listQuestions(@Param('categoryId') categoryId: string) {
    return this.questionsService.listQuestions(categoryId);
  }

  @Post('categories/:categoryId/questions')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  createQuestion(@Param('categoryId') categoryId: string, @Body() dto: CreateQuestionDto) {
    return this.questionsService.createQuestion(categoryId, dto);
  }

  @Patch('questions/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  updateQuestion(@Param('id') id: string, @Body() dto: UpdateQuestionDto) {
    return this.questionsService.updateQuestion(id, dto);
  }

  @Patch('questions/:id/status')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  updateQuestionStatus(@Param('id') id: string, @Body() dto: UpdateQuestionStatusDto) {
    return this.questionsService.updateQuestionStatus(id, dto.isActive);
  }

  @Delete('questions/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  softDeleteQuestion(@Param('id') id: string) {
    return this.questionsService.updateQuestionStatus(id, false);
  }
}
