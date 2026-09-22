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
import { AdminPermission } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { AuthGuard } from '../auth/auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
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
   * QUESTIONS_READ. The public request form gets its questions from
   * `GET /categories/:slug`, which serves only categories a visitor may reach
   * and leaves the routing destinations out; this listing does neither, so it
   * is not a public endpoint.
   */
  @Get('categories/:categoryId/questions')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.QUESTIONS_READ)
  listQuestions(@Param('categoryId') categoryId: string) {
    return this.questionsService.listQuestions(categoryId);
  }

  @Post('categories/:categoryId/questions')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.QUESTIONS_WRITE)
  createQuestion(@Param('categoryId') categoryId: string, @Body() dto: CreateQuestionDto) {
    return this.questionsService.createQuestion(categoryId, dto);
  }

  @Patch('questions/:id')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.QUESTIONS_WRITE)
  updateQuestion(@Param('id') id: string, @Body() dto: UpdateQuestionDto) {
    return this.questionsService.updateQuestion(id, dto);
  }

  @Patch('questions/:id/status')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.QUESTIONS_WRITE)
  updateQuestionStatus(@Param('id') id: string, @Body() dto: UpdateQuestionStatusDto) {
    return this.questionsService.updateQuestionStatus(id, dto.isActive);
  }

  /**
   * The complete visibility rule set for one question, replaced in one call —
   * the rules are ANDed together and only mean anything as a set.
   */
  @Put('questions/:id/conditions')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.QUESTIONS_WRITE)
  replaceQuestionConditions(
    @Param('id') id: string,
    @Body() dto: ReplaceQuestionConditionsDto,
  ) {
    return this.questionsService.replaceConditions(id, dto);
  }

  /** The complete option → destination map of a routing question. */
  @Put('questions/:id/router-rules')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.QUESTIONS_WRITE)
  replaceRouterRules(@Param('id') id: string, @Body() dto: ReplaceRouterRulesDto) {
    return this.questionsService.replaceRouterRules(id, dto);
  }

  @Delete('questions/:id')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.QUESTIONS_DELETE)
  softDeleteQuestion(@Param('id') id: string) {
    return this.questionsService.updateQuestionStatus(id, false);
  }
}
