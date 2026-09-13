import { Body, Controller, HttpCode, HttpStatus, Inject, Logger, Post, UseGuards } from '@nestjs/common';
import { CustomerActivationService } from '../customer-activation/customer-activation.service';
import { AuthThrottlerGuard } from './auth.throttler';
import { RequestIdentityActivateDto, RequestIdentityCheckDto } from './dto/request-identity.dto';
import { RequestIdentityService } from './request-identity.service';

/**
 * Asks, before a request form is filled in, whether its author already has an
 * account. Session-less and rate limited: the answer is one of five product
 * states and carries nothing about the account itself.
 */
@Controller('auth/request-identity-check')
export class RequestIdentityController {
  private readonly logger = new Logger(RequestIdentityController.name);

  constructor(
    @Inject(RequestIdentityService) private readonly identity: RequestIdentityService,
    @Inject(CustomerActivationService) private readonly activation: CustomerActivationService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthThrottlerGuard)
  async check(@Body() dto: RequestIdentityCheckDto) {
    const { status } = await this.identity.classifyNow(dto);
    return { status };
  }

  /**
   * Re-sends the claim link for a password-less account the pair points at.
   *
   * The recipient is the account's own stored e-mail — read inside
   * issueForAutoCreatedCustomer, never taken from this body. Somebody who knows
   * a victim's number and types their own address gets a 202 and nothing else;
   * the mail, if any, goes to the victim. Every other state is the same 202
   * with no mail, so the endpoint reveals nothing on its own.
   */
  @Post('activate')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(AuthThrottlerGuard)
  async activate(@Body() dto: RequestIdentityActivateDto) {
    const { status, matchedCustomerId } = await this.identity.classifyNow(dto);

    if (status === 'activation-required' && matchedCustomerId) {
      try {
        await this.activation.issueForAutoCreatedCustomer(matchedCustomerId, {
          redirectTo: dto.redirectTo ?? null,
        });
      } catch (error) {
        // Best effort by design: the answer must not change with the outcome.
        // Logged without the phone or e-mail from the body — matchedCustomerId
        // is enough to find the account without echoing what the caller sent.
        this.logger.error(
          'request-identity activate: failed to issue activation link',
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return { status: 'accepted' as const };
  }
}
