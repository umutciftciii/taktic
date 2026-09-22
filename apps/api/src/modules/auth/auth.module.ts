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
import {
  SERVICE_REQUEST_THROTTLE_LIMIT,
  SERVICE_REQUEST_THROTTLE_TTL_MS,
} from '../service-requests/service-requests.constants';
import { AdminAccessGuard } from './admin-access.guard';
import { PermissionsGuard } from './permissions.guard';
import { RolesGuard } from './roles.guard';

@Module({
  imports: [
    PrismaModule,
    CustomerActivationModule,
    // The verification routes below need this module's guards, and registration
    // needs its service. Declaring the controller here rather than there is
    // what keeps the two modules from depending on each other.
    EmailVerificationModule,
    // Registered here (not globally) so only the routes that explicitly add
    // AuthThrottlerGuard, RequestDraftThrottlerGuard or
    // ServiceRequestThrottlerGuard are throttled at all.
    //
    // All three named throttlers live in this one `forRoot` call because
    // `@nestjs/throttler` v6 does not merge two separate `forRoot`
    // registrations — a second one (e.g. inside RequestDraftsModule or
    // ServiceRequestsModule) gives guards declared there their own
    // options/storage that `resetAuthThrottle` cannot reach (confirmed: the
    // draft endpoint 429'd on unrelated earlier test cases a reset never
    // touched). Sharing one options object also means the base
    // `ThrottlerGuard.canActivate` would enforce *every* named entry on every
    // guarded route unless told otherwise. Throttler storage keys are class +
    // handler + throttler name + tracker, so this is not shared consumption
    // across routes — it is every AuthThrottlerGuard route silently gaining
    // independent `request-drafts` and `service-requests` counters (and
    // likewise for the other two guards' own routes) on top of the one each
    // already enforces, an extra unrelated cap nobody asked for. Rather than
    // annotate every route (and every future one) with `@SkipThrottle`, each
    // guard class scopes itself to its own name in `onModuleInit` — see
    // AuthThrottlerGuard, RequestDraftThrottlerGuard and
    // ServiceRequestThrottlerGuard.
    ThrottlerModule.forRoot([
      { name: 'auth', ttl: AUTH_THROTTLE_TTL_MS, limit: AUTH_THROTTLE_LIMIT },
      { name: 'request-drafts', ttl: REQUEST_DRAFT_THROTTLE_TTL_MS, limit: REQUEST_DRAFT_THROTTLE_LIMIT },
      { name: 'service-requests', ttl: SERVICE_REQUEST_THROTTLE_TTL_MS, limit: SERVICE_REQUEST_THROTTLE_LIMIT },
    ]),
  ],
  controllers: [AuthController, EmailVerificationController, RequestIdentityController],
  providers: [
    AuthService,
    AuthGuard,
    OptionalAuthGuard,
    RolesGuard,
    AdminAccessGuard,
    PermissionsGuard,
    ProviderAccessGuard,
    AuthThrottlerGuard,
    RequestIdentityService,
  ],
  exports: [
    AuthService,
    AuthGuard,
    OptionalAuthGuard,
    RolesGuard,
    AdminAccessGuard,
    PermissionsGuard,
    ProviderAccessGuard,
    RequestIdentityService,
    AuthThrottlerGuard,
  ],
})
export class AuthModule {}
