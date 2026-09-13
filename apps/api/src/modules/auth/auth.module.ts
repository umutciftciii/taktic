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
import { RequestIdentityController } from './request-identity.controller';
import { RequestIdentityService } from './request-identity.service';
import {
  REQUEST_DRAFT_THROTTLE_LIMIT,
  REQUEST_DRAFT_THROTTLE_TTL_MS,
} from '../request-drafts/request-drafts.constants';
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
    // AuthController and the request-drafts endpoint are throttled — see
    // AuthThrottlerGuard.
    //
    // Both throttlers live in this one `forRoot` call on purpose: `forRoot`
    // makes its module global, and `@nestjs/throttler` v6 does not merge two
    // separate `forRoot` registrations — a second one (e.g. inside
    // RequestDraftsModule) gives guards declared there their own
    // options/storage that `resetAuthThrottle` cannot reach. Every route this
    // pair of throttlers does not name explicitly is skipped for it via
    // `@SkipThrottle` (see AuthController, RequestIdentityController and
    // RequestDraftsController), so drafting never spends a caller's login
    // budget and logging in never spends their draft budget.
    ThrottlerModule.forRoot([
      { name: 'auth', ttl: AUTH_THROTTLE_TTL_MS, limit: AUTH_THROTTLE_LIMIT },
      { name: 'request-drafts', ttl: REQUEST_DRAFT_THROTTLE_TTL_MS, limit: REQUEST_DRAFT_THROTTLE_LIMIT },
    ]),
  ],
  controllers: [AuthController, EmailVerificationController, RequestIdentityController],
  providers: [
    AuthService,
    AuthGuard,
    OptionalAuthGuard,
    RolesGuard,
    ProviderAccessGuard,
    AuthThrottlerGuard,
    RequestIdentityService,
  ],
  exports: [
    AuthService,
    AuthGuard,
    OptionalAuthGuard,
    RolesGuard,
    ProviderAccessGuard,
    RequestIdentityService,
    AuthThrottlerGuard,
  ],
})
export class AuthModule {}
