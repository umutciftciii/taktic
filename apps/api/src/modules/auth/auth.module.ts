import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from '../../prisma/prisma.module';
import { CustomerActivationModule } from '../customer-activation/customer-activation.module';
import { EmailVerificationModule } from '../email-verification/email-verification.module';
import { AuthController } from './auth.controller';
import { AuthGuard, OptionalAuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { EmailVerificationController } from './email-verification.controller';
import { AUTH_THROTTLE_LIMIT, AUTH_THROTTLE_TTL_MS, AuthThrottlerGuard } from './auth.throttler';
import { ProviderAccessGuard } from './provider-access.guard';
import { RolesGuard } from './roles.guard';

@Module({
  imports: [
    PrismaModule,
    CustomerActivationModule,
    // The verification routes below need this module's guards, and registration
    // needs its service. Declaring the controller here rather than there is
    // what keeps the two modules from depending on each other.
    EmailVerificationModule,
    // Registered here (not globally) so only the credential endpoints in
    // AuthController are throttled — see AuthThrottlerGuard.
    ThrottlerModule.forRoot([
      { name: 'auth', ttl: AUTH_THROTTLE_TTL_MS, limit: AUTH_THROTTLE_LIMIT },
    ]),
  ],
  controllers: [AuthController, EmailVerificationController],
  providers: [
    AuthService,
    AuthGuard,
    OptionalAuthGuard,
    RolesGuard,
    ProviderAccessGuard,
    AuthThrottlerGuard,
  ],
  exports: [AuthService, AuthGuard, OptionalAuthGuard, RolesGuard, ProviderAccessGuard],
})
export class AuthModule {}
