import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from '../../prisma/prisma.module';
import { CustomerActivationModule } from '../customer-activation/customer-activation.module';
import { AuthController } from './auth.controller';
import { AuthGuard, OptionalAuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { AUTH_THROTTLE_LIMIT, AUTH_THROTTLE_TTL_MS, AuthThrottlerGuard } from './auth.throttler';
import { ProviderAccessGuard } from './provider-access.guard';
import { RolesGuard } from './roles.guard';

@Module({
  imports: [
    PrismaModule,
    CustomerActivationModule,
    // Registered here (not globally) so only the credential endpoints in
    // AuthController are throttled — see AuthThrottlerGuard.
    ThrottlerModule.forRoot([
      { name: 'auth', ttl: AUTH_THROTTLE_TTL_MS, limit: AUTH_THROTTLE_LIMIT },
    ]),
  ],
  controllers: [AuthController],
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
