import { BadRequestException, Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
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
  submit(@Body() dto: SubmitCustomerActivationDto) {
    return this.activationService.submit(dto);
  }
}
