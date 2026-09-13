import { Body, Controller, Delete, Get, HttpCode, HttpException, HttpStatus, Inject, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { OptionalAuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { CreateRequestDraftDto, CurrentRequestDraftQueryDto } from './dto/create-request-draft.dto';
import { getDraftTokenFromRequest } from './request-draft.cookie';
import { RequestDraftThrottlerGuard } from './request-draft.throttler';
import { RequestDraftsService } from './request-drafts.service';

type IncomingRequest = { headers?: Record<string, string | string[] | undefined> };
type OutgoingResponse = { setHeader(name: string, value: string): void; status(code: number): OutgoingResponse };

/**
 * A request form parked on the server while its author signs in or activates.
 * The token travels only in the web app's HttpOnly cookie, which the web
 * server forwards here like the session cookie; no route below ever returns
 * expectedUserId or userId.
 */
@Controller('request-drafts')
export class RequestDraftsController {
  constructor(@Inject(RequestDraftsService) private readonly drafts: RequestDraftsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  // Its own named bucket on AuthModule's shared forRoot — five drafts per
  // client per ten minutes. RequestDraftThrottlerGuard's onModuleInit (see
  // auth.throttler.ts) narrows it to only the `request-drafts` throttler, so
  // this route never touches the credential endpoints' `auth` budget: a
  // browser drafting several forms must never spend the budget it would need
  // to sign in.
  @UseGuards(RequestDraftThrottlerGuard)
  async create(@Body() dto: CreateRequestDraftDto, @Req() req: IncomingRequest, @Res({ passthrough: true }) res: OutgoingResponse) {
    try {
      return await this.drafts.create(
        {
          key: { formType: dto.formType, categorySlug: dto.categorySlug, cardId: dto.cardId ?? null },
          payload: dto.payload,
          identity: dto.identity,
          replace: dto.replace === true,
        },
        getDraftTokenFromRequest(req),
      );
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 503) {
        res.setHeader('Retry-After', '60');
      }
      throw error;
    }
  }

  @Get('current')
  @UseGuards(OptionalAuthGuard)
  async current(
    @Query() query: CurrentRequestDraftQueryDto,
    @CurrentUser() user: AuthUser | null,
    @Req() req: IncomingRequest,
    @Res({ passthrough: true }) res: OutgoingResponse,
  ) {
    const result = await this.drafts.current(
      getDraftTokenFromRequest(req),
      { formType: query.formType, categorySlug: query.categorySlug, cardId: query.cardId ?? null },
      user?.id ?? null,
    );
    if (result.kind === 'none') {
      res.status(HttpStatus.NO_CONTENT);
      return;
    }
    return result.kind === 'payload' ? { payload: result.payload } : { status: 'wrong-account' };
  }

  @Delete('current')
  @HttpCode(HttpStatus.NO_CONTENT)
  async discard(@Req() req: IncomingRequest) {
    await this.drafts.discard(getDraftTokenFromRequest(req));
  }
}
