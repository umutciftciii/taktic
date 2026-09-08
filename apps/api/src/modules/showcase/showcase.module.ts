import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AdminShowcaseController } from './admin-showcase.controller';
import { AdminShowcaseService } from './admin-showcase.service';
import { UploadsModule } from '../uploads/uploads.module';
import { ProviderShowcaseCardsController } from './provider-showcase-cards.controller';
import { ProviderShowcaseCardsService } from './provider-showcase-cards.service';
import { ShowcaseUploadsController } from './showcase-uploads.controller';

/**
 * Vitrin cards — the bounded context, phase one.
 *
 * One module, two surfaces, split by authority rather than by entity: the
 * business that writes a card, and the operator that decides about it. They
 * share the schema and the projection, and share no service method at all,
 * because every method one of them may call is one the other may not.
 *
 * What this module deliberately does not import: nothing about payments,
 * entitlements, requests, offers, credits or notifications. A vitrin card in
 * this phase is a reviewed text and nothing else — it costs nothing to hold, it
 * charges nobody, it appears on no customer surface and it sends no mail. The
 * absence of those imports is what keeps that true.
 */
@Module({
  imports: [PrismaModule, AuthModule, UploadsModule],
  controllers: [
    ProviderShowcaseCardsController,
    ShowcaseUploadsController,
    AdminShowcaseController,
  ],
  providers: [ProviderShowcaseCardsService, AdminShowcaseService],
})
export class ShowcaseModule {}
