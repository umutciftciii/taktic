import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { sessionCookie } from '../auth/cookie';
import { CustomerActivationService } from './customer-activation.service';
import { SubmitCustomerActivationDto } from './dto/submit-customer-activation.dto';

@Controller('auth/customer-activation')
export class CustomerActivationController {
  constructor(
    @Inject(CustomerActivationService)
    private readonly activationService: CustomerActivationService,
  ) {}

  @Get()
  validate(@Query('token') token?: string) {
    if (!token || !token.trim()) {
      throw new BadRequestException('Token is required');
    }

    return this.activationService.validateRawToken(token);
  }

  @Post()
  async submit(
    @Body() dto: SubmitCustomerActivationDto,
    @Req() request: any,
    @Res({ passthrough: true }) response: any,
  ) {
    const result = await this.activationService.submit(dto, {
      ipAddress: request.ip ?? null,
      userAgent: request.headers?.['user-agent'] ?? null,
    });

    // Setting the password logs the customer straight in, so they land on their
    // own requests/offers instead of being bounced to a login screen.
    response.setHeader('Set-Cookie', sessionCookie(result.sessionId, result.expiresAt, false));

    return { success: result.success, user: result.user };
  }
}
