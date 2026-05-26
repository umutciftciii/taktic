import { Body, Controller, Delete, Get, Inject, Param, Patch, Post } from '@nestjs/common';
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
  createQuestion(@Param('categoryId') categoryId: string, @Body() dto: CreateQuestionDto) {
    return this.questionsService.createQuestion(categoryId, dto);
  }

  @Patch('questions/:id')
  updateQuestion(@Param('id') id: string, @Body() dto: UpdateQuestionDto) {
    return this.questionsService.updateQuestion(id, dto);
  }

  @Patch('questions/:id/status')
  updateQuestionStatus(@Param('id') id: string, @Body() dto: UpdateQuestionStatusDto) {
    return this.questionsService.updateQuestionStatus(id, dto.isActive);
  }

  @Delete('questions/:id')
  softDeleteQuestion(@Param('id') id: string) {
    return this.questionsService.updateQuestionStatus(id, false);
  }
}
