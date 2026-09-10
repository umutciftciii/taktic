import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ShowcaseLeadLifecycleService } from './showcase-lead-lifecycle.service';
import { ShowcasePlacementService } from './showcase-placement.service';

/**
 * The parts of vitrin that other bounded contexts have to change **inside their
 * own transactions**.
 *
 * ## Why this module exists
 *
 * Four things outside vitrin can change a placement or a lead, and every one of
 * them has to do it atomically with its own write:
 *
 * - a settled payment becomes a placement (payments, and the mock settlement);
 * - a closed category takes its shelf's runs off the air (categories);
 * - a suspended business, or one that narrowed its coverage, loses its runs
 *   (providers);
 * - a refused or cancelled request closes its lead, and an offer on a direct
 *   lead marks it answered (service requests, providers).
 *
 * The alternative — an event those modules emit and vitrin reacts to — would
 * put the two halves in different transactions, and a card left on the home
 * page because the second half failed is exactly the state this arrangement
 * makes impossible.
 *
 * ## Why it is separate from `ShowcaseModule`
 *
 * `ShowcaseModule` depends on service requests, payments, notifications and
 * phone verification, because opening a lead and opening a checkout need all
 * four. If the call-backs above lived there too, every one of those four
 * modules would end up mutually dependent with it — and a `forwardRef` does not
 * contain that: the cycle propagates through every module that reaches either
 * side, and Nest resolves one of them to `undefined` while scanning.
 *
 * So the direction is split. This module holds only what is called *into*
 * vitrin from elsewhere, and it depends on nothing but Prisma — which means
 * anybody may import it, and nobody is put in a cycle by doing so.
 * `ShowcaseModule` holds what calls *out*, and imports this one like everyone
 * else.
 */
@Module({
  imports: [PrismaModule],
  providers: [ShowcasePlacementService, ShowcaseLeadLifecycleService],
  exports: [ShowcasePlacementService, ShowcaseLeadLifecycleService],
})
export class ShowcaseLifecycleModule {}
