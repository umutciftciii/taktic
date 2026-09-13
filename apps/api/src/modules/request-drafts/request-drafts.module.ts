import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { RequestDraftThrottlerGuard } from './request-draft.throttler';
import { RequestDraftsController } from './request-drafts.controller';
import { RequestDraftsService } from './request-drafts.service';

/**
 * No `ThrottlerModule.forRoot` here.
 *
 * `@nestjs/throttler` v6's `forRoot` marks its module global, and a second
 * `forRoot` call — even in an unrelated module — does not merge with the
 * first: it gives every guard declared inside *this* module its own separate
 * options/storage, so `RequestDraftThrottlerGuard` would enforce a bucket
 * `resetAuthThrottle` never touches (proven by the draft endpoint 429ing on
 * its 6th call across unrelated test cases that never reset between them).
 * The draft budget is instead a second named throttler on AuthModule's one
 * `forRoot` — see auth.module.ts and request-drafts.controller.ts's
 * `@Throttle`/`@SkipThrottle` pair.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [RequestDraftsController],
  providers: [RequestDraftsService, RequestDraftThrottlerGuard],
  exports: [RequestDraftsService],
})
export class RequestDraftsModule {}
