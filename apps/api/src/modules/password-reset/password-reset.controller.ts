import { BadRequestException, Body, Controller, Get, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { AuthThrottlerGuard } from '../auth/auth.throttler';
import { ConfirmPasswordResetDto } from './dto/confirm-password-reset.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { PasswordResetService } from './password-reset.service';

/**
 * Throttled like the credential endpoints it belongs beside, and for the same
 * reason: these three routes are the ones an attacker replays. The per-account
 * budget inside the service is the other half — this one bounds a single
 * client, that one bounds what any number of clients can do to one mailbox.
 */
@Controller('auth/password-reset')
@UseGuards(AuthThrottlerGuard)
export class PasswordResetController {
  constructor(@Inject(PasswordResetService) private readonly service: PasswordResetService) {}

  /** Always 200 with the same body, whether or not the address is registered. */
  @Post()
  request(@Body() dto: RequestPasswordResetDto) {
    return this.service.request(dto);
  }

  @Get()
  validate(@Query('token') token?: string) {
    if (!token || !token.trim()) {
      throw new BadRequestException('Token is required');
    }

    return this.service.validate(token);
  }

  /**
   * Deliberately issues no session. The reset has just revoked every session
   * this account had, and handing a new one back would undo half of that; the
   * person signs in with the password they chose.
   */
  @Post('confirm')
  confirm(@Body() dto: ConfirmPasswordResetDto) {
    return this.service.confirm(dto);
  }
}
