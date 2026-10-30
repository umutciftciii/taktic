import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { WEB_SURFACE_CHANNEL } from '../../common/web-surface-channel';
import { ConfirmEmailVerificationDto } from '../email-verification/dto/confirm-email-verification.dto';
import { EmailVerificationService } from '../email-verification/email-verification.service';
import { AuthGuard } from './auth.guard';
import { AuthThrottlerGuard } from './auth.throttler';
import { TurnstileAction } from '../turnstile/turnstile.decorators';
import { TurnstileGuard } from '../turnstile/turnstile.guard';
import { TURNSTILE_ACTIONS } from '../turnstile/turnstile.constants';

@Controller('auth/email-verification')
@UseGuards(AuthThrottlerGuard)
export class EmailVerificationController {
  constructor(
    @Inject(EmailVerificationService) private readonly service: EmailVerificationService,
  ) {}

  /**
   * Behind the session guard on purpose.
   *
   * Taking an address instead would hand anybody a way to mail a stranger, and
   * an authenticated caller can only ever ask for a link to their own address —
   * which is the address in question. Registration signs the customer in, so
   * the person who needs this always has a session.
   *
   * SEC-AUTH-ABUSE-001: and a Turnstile token, so a stolen or scripted session
   * cannot turn this into a mail cannon. Checked before the session, like the
   * other protected writes.
   */
  @Post('resend')
  @UseGuards(TurnstileGuard, AuthGuard)
  @TurnstileAction(TURNSTILE_ACTIONS.emailVerificationResend)
  resend(@Req() request: any) {
    return this.service.resend(request.user.id);
  }

  @Get()
  validate(@Query('token') token?: string) {
    if (!token || !token.trim()) {
      throw new BadRequestException('Token is required');
    }

    return this.service.validate(token);
  }

  /**
   * No session required: the link is opened from an inbox. The web
   * application's confirmation page is this route's client, so the proof it
   * confirms carries WEB (CMP-006 PR-D) — from the route, not the request.
   */
  @Post('confirm')
  confirm(@Body() dto: ConfirmEmailVerificationDto) {
    return this.service.confirm(dto.token, WEB_SURFACE_CHANNEL);
  }
}
