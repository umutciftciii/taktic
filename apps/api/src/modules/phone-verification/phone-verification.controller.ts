import { Body, Controller, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
import { VerifyPhoneCodeDto } from './dto/verify-phone-code.dto';
import { PhoneVerificationService, VerificationRequestMeta } from './phone-verification.service';

/**
 * Both routes require a signed-in customer who owns the request (or an admin).
 * Anonymous callers are refused: a guest whose account was auto-created must
 * claim it through the existing activation link first, which is the same proof
 * of identity the rest of the customer surface requires.
 */
@Controller('service-requests/:requestId/phone-verification')
export class PhoneVerificationController {
  constructor(
    @Inject(PhoneVerificationService)
    private readonly phoneVerificationService: PhoneVerificationService,
  ) {}

  @Post()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER, UserRole.SUPER_ADMIN)
  sendCode(
    @Param('requestId') requestId: string,
    @CurrentUser() user: AuthUser,
    @Req() req: IncomingRequest,
  ) {
    return this.phoneVerificationService.sendCode(requestId, user, readMeta(req));
  }

  @Post('verify')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER, UserRole.SUPER_ADMIN)
  verifyCode(
    @Param('requestId') requestId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: VerifyPhoneCodeDto,
    @Req() req: IncomingRequest,
  ) {
    return this.phoneVerificationService.verifyCode(requestId, user, dto.code, readMeta(req));
  }
}

/**
 * Structural subset of the Express request. Declared locally because the API
 * does not depend on @types/express directly — the same approach AuthThrottler
 * takes.
 */
type IncomingRequest = {
  ip?: unknown;
  headers?: Record<string, unknown>;
};

function readMeta(req: IncomingRequest): VerificationRequestMeta {
  const userAgent = req.headers?.['user-agent'];

  return {
    // Same source the auth throttler keys off, so both honour TRUST_PROXY.
    ipAddress: typeof req.ip === 'string' && req.ip ? req.ip : null,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 255) : null,
  };
}
