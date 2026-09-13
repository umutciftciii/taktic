import { Body, Controller, HttpCode, HttpStatus, Inject, Post, UseGuards } from '@nestjs/common';
import { AuthThrottlerGuard } from './auth.throttler';
import { RequestIdentityCheckDto } from './dto/request-identity.dto';
import { RequestIdentityService } from './request-identity.service';

/**
 * Asks, before a request form is filled in, whether its author already has an
 * account. Session-less and rate limited: the answer is one of five product
 * states and carries nothing about the account itself.
 */
@Controller('auth/request-identity-check')
export class RequestIdentityController {
  constructor(@Inject(RequestIdentityService) private readonly identity: RequestIdentityService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthThrottlerGuard)
  async check(@Body() dto: RequestIdentityCheckDto) {
    const { status } = await this.identity.classifyNow(dto);
    return { status };
  }
}
