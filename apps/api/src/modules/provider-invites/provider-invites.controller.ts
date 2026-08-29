import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { OptionalAuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { SubmitProviderInviteApplicationDto } from './dto/submit-provider-invite-application.dto';
import { ProviderInvitesService } from './provider-invites.service';

/**
 * The public half of the invitation flow.
 *
 * Both routes are reachable without a session, because the whole point is that
 * the business being recruited has no account here yet. The token is the only
 * credential either accepts, and it grants exactly one thing: the right to
 * submit one application against one category.
 *
 * OptionalAuthGuard rather than no guard, for the same reason `POST /providers`
 * has it: a caller who *is* signed in must be recognised, so a provider account
 * that follows an invitation owns the application it creates, and a customer
 * account is refused rather than quietly producing a provider profile.
 */
@Controller('provider-invites')
export class ProviderInvitesController {
  constructor(
    @Inject(ProviderInvitesService) private readonly invites: ProviderInvitesService,
  ) {}

  /**
   * What the invitation screen may render: the service's name and the expiry.
   *
   * The token is a path parameter here because that is the shape of the link
   * the recipient was given, and this is the request their browser makes by
   * following it. Every request after this one carries it in a body instead.
   */
  @Get(':token')
  @UseGuards(OptionalAuthGuard)
  describe(@Param('token') token: string) {
    return this.invites.describeInvite(token);
  }

  /**
   * Spends the invitation and records the application.
   *
   * The route deliberately has no token in its path. A form submission is the
   * one request in this flow whose target URL is written by us rather than by
   * the link, so it is the one place the token can be kept out of a URL
   * entirely — out of browser history, out of `Referer`, out of every access
   * log between the browser and this process.
   */
  @Post('applications')
  @UseGuards(OptionalAuthGuard)
  submit(
    @Body() dto: SubmitProviderInviteApplicationDto,
    @CurrentUser() user: AuthUser | null,
    @Req() request: any,
  ) {
    // The client address is passed through only so the claim invitation this
    // may trigger can be rate limited. It is never stored.
    return this.invites.submitApplication(dto, user, {
      ipAddress: request.ip ?? null,
      userAgent: request.headers?.['user-agent'] ?? null,
    });
  }
}
