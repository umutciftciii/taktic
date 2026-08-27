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
import { ConfirmEmailVerificationDto } from '../email-verification/dto/confirm-email-verification.dto';
import { EmailVerificationService } from '../email-verification/email-verification.service';
import { AuthGuard } from './auth.guard';
import { AuthThrottlerGuard } from './auth.throttler';

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
   */
  @Post('resend')
  @UseGuards(AuthGuard)
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

  /** No session required: the link is opened from an inbox. */
  @Post('confirm')
  confirm(@Body() dto: ConfirmEmailVerificationDto) {
    return this.service.confirm(dto.token);
  }
}
