import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CreateQuestionDto } from './dto/create-question.dto';
import { ReplaceQuestionConditionsDto } from './dto/replace-question-conditions.dto';
import { ReplaceRouterRulesDto } from './dto/replace-router-rules.dto';
import { UpdateQuestionStatusDto } from './dto/update-question-status.dto';
import { UpdateQuestionDto } from './dto/update-question.dto';
import { QuestionsService } from './questions.service';

@Controller()
export class QuestionsController {
  constructor(@Inject(QuestionsService) private readonly questionsService: QuestionsService) {}

  /**
   * The full question set of one category, including its visibility rules and
   * its routing destinations — the management view.
   *
   * SUPER_ADMIN only. The public request form gets its questions from
   * `GET /categories/:slug`, which serves only categories a visitor may reach
   * and leaves the routing destinations out; this listing does neither, so it
   * is not a public endpoint.
   */
  @Get('categories/:categoryId/questions')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
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

  /**
   * The complete visibility rule set for one question, replaced in one call —
   * the rules are ANDed together and only mean anything as a set.
   */
  @Put('questions/:id/conditions')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  replaceQuestionConditions(
    @Param('id') id: string,
    @Body() dto: ReplaceQuestionConditionsDto,
  ) {
    return this.questionsService.replaceConditions(id, dto);
  }

  /** The complete option → destination map of a routing question. */
  @Put('questions/:id/router-rules')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  replaceRouterRules(@Param('id') id: string, @Body() dto: ReplaceRouterRulesDto) {
    return this.questionsService.replaceRouterRules(id, dto);
  }

  @Delete('questions/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  softDeleteQuestion(@Param('id') id: string) {
    return this.questionsService.updateQuestionStatus(id, false);
  }
}
