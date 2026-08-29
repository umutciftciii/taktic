import { Body, Controller, Get, Inject, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { OptionalAuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { sessionCookie } from '../auth/cookie';
import { SubmitProviderClaimDto } from './dto/submit-provider-claim.dto';
import { claimTokenInvalidException } from './provider-claim.errors';
import { ProviderClaimService } from './provider-claim.service';

/**
 * The public half of the claim flow.
 *
 * Both routes are reachable without a session — the whole point is that the
 * applicant may not have an account yet — and the token in the query string or
 * the body is the only credential either accepts. OptionalAuthGuard is here so
 * a caller who *is* signed in can be recognised: a provider account that
 * already owns this address is linked to the application rather than being told
 * to create a second one.
 */
@Controller('auth/provider-claim')
export class ProviderClaimController {
  constructor(
    @Inject(ProviderClaimService) private readonly providerClaim: ProviderClaimService,
  ) {}

  @Get()
  @UseGuards(OptionalAuthGuard)
  validate(@CurrentUser() user: AuthUser | null, @Query('token') token?: string) {
    if (!token || !token.trim()) {
      // The same refusal a wrong token gets: a missing one must not be a
      // distinguishable answer either.
      throw claimTokenInvalidException();
    }

    return this.providerClaim.validateRawToken(token, user);
  }

  @Post()
  @UseGuards(OptionalAuthGuard)
  async submit(
    @Body() dto: SubmitProviderClaimDto,
    @CurrentUser() user: AuthUser | null,
    @Req() request: any,
    @Res({ passthrough: true }) response: any,
  ) {
    const result = await this.providerClaim.submit(dto, user, {
      ipAddress: request.ip ?? null,
      userAgent: request.headers?.['user-agent'] ?? null,
    });

    // Claiming signs the provider in, so they land on their own panel instead
    // of being bounced to a login screen holding a token they just spent.
    response.setHeader('Set-Cookie', sessionCookie(result.sessionId, result.expiresAt, false));

    return {
      success: result.success,
      providerId: result.providerId,
      user: result.user,
    };
  }
}
