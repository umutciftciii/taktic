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
  // client per ten minutes. Throttler storage keys are class + handler +
  // throttler name + tracker, so without scoping, this route would not share
  // a budget with the credential endpoints — it would instead pick up a
  // second, independent `request-drafts` counter on top of whatever `auth`
  // check a guard already applied, an unwanted extra cap nobody asked for.
  // RequestDraftThrottlerGuard's onModuleInit (see auth.throttler.ts) keeps
  // only the `request-drafts` throttler for this guard, so this route
  // enforces exactly one counter and nothing about the `auth` one.
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

  /**
   * "Vazgeç" on a form that opened a draft. Keyed and guarded exactly like
   * GET: the row goes only when it is the one this form showed — same
   * key, and anonymous or the session's own. A wrong account, another form's
   * cookie or a bare token deletes nothing. Always 200 with `{ deleted }`, so
   * the web knows whether the cookie it holds still names a live row.
   */
  @Delete('current')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OptionalAuthGuard)
  async discard(
    @Query() query: CurrentRequestDraftQueryDto,
    @CurrentUser() user: AuthUser | null,
    @Req() req: IncomingRequest,
  ): Promise<{ deleted: boolean }> {
    const deleted = await this.drafts.discard(
      getDraftTokenFromRequest(req),
      { formType: query.formType, categorySlug: query.categorySlug, cardId: query.cardId ?? null },
      user?.id ?? null,
    );
    return { deleted };
  }
}
