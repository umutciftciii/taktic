import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AuthThrottlerGuard } from '../auth/auth.throttler';
import { PasswordResetController } from './password-reset.controller';
import { PasswordResetService } from './password-reset.service';

/**
 * AuthModule is imported for the ThrottlerModule registration it carries: the
 * limiter is configured there, deliberately not globally, and these routes are
 * part of the same credential surface it protects.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [PasswordResetController],
  providers: [PasswordResetService, AuthThrottlerGuard],
  exports: [PasswordResetService],
})
export class PasswordResetModule {}
