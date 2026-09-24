import { Body, Controller, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { WEB_SURFACE_CHANNEL } from '../../common/web-surface-channel';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
import { TurnstileAction } from '../turnstile/turnstile.decorators';
import { TurnstileGuard } from '../turnstile/turnstile.guard';
import { TURNSTILE_ACTIONS } from '../turnstile/turnstile.constants';
import { VerifyPhoneCodeDto } from './dto/verify-phone-code.dto';
import { PhoneVerificationService, VerificationRequestMeta } from './phone-verification.service';

/**
 * A provider proving its own account number (AUTH-PROVIDER-CONTACT-001).
 *
 * `me` and nothing else: the account is the session's, no id travels in the
 * path or the body, so there is no request a caller can compose about another
 * account, another number or another provider. The guard order is the one
 * every protected write uses — Turnstile ahead of the session on the send that
 * costs an SMS, and no Turnstile on the verify, which spends nothing and has
 * its own attempt budget.
 */
@Controller('providers/me/phone-verification')
export class ProviderPhoneVerificationController {
  constructor(
    @Inject(PhoneVerificationService)
    private readonly phoneVerificationService: PhoneVerificationService,
  ) {}

  @Post()
  @UseGuards(TurnstileGuard, AuthGuard, RolesGuard)
  @TurnstileAction(TURNSTILE_ACTIONS.phoneCodeSend)
  @Roles(UserRole.PROVIDER)
  sendCode(@CurrentUser() user: AuthUser, @Req() req: IncomingRequest) {
    return this.phoneVerificationService.sendAccountCode(user, readMeta(req));
  }

  @Post('verify')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.PROVIDER)
  verifyCode(
    @CurrentUser() user: AuthUser,
    @Body() dto: VerifyPhoneCodeDto,
    @Req() req: IncomingRequest,
  ) {
    // The web application's OTP form is this route's client: WEB, from the
    // route (CMP-006 PR-D) — nothing in the request names a channel.
    return this.phoneVerificationService.verifyAccountCode(user, dto.code, readMeta(req), WEB_SURFACE_CHANNEL);
  }
}

/** Structural subset of the Express request — see PhoneVerificationController. */
type IncomingRequest = {
  ip?: unknown;
  headers?: Record<string, unknown>;
};

function readMeta(req: IncomingRequest): VerificationRequestMeta {
  const userAgent = req.headers?.['user-agent'];

  return {
    ipAddress: typeof req.ip === 'string' && req.ip ? req.ip : null,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 255) : null,
  };
}
