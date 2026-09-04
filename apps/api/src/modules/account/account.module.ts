import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AuthThrottlerGuard } from '../auth/auth.throttler';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';

/**
 * AuthModule is imported for two things: the guards these routes stand behind,
 * and the ThrottlerModule registration it carries. The limiter is configured
 * there rather than globally, and the password route is part of the same
 * credential surface it protects.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [AccountController],
  providers: [AccountService, AuthThrottlerGuard],
  exports: [AccountService],
})
export class AccountModule {}
