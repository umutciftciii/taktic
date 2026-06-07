import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
} from '@nestjs/common';
import { AdminInviteService } from './admin-invite.service';
import { SubmitAdminInviteDto } from './dto/submit-admin-invite.dto';

@Controller('auth/admin-invite')
export class AdminInviteController {
  constructor(
    @Inject(AdminInviteService)
    private readonly inviteService: AdminInviteService,
  ) {}

  @Get()
  validate(@Query('token') token?: string) {
    if (!token || !token.trim()) {
      throw new BadRequestException('Token is required');
    }

    return this.inviteService.validateRawToken(token);
  }

  @Post()
  submit(@Body() dto: SubmitAdminInviteDto) {
    return this.inviteService.submit(dto);
  }
}
