import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { NumberingModule } from '../numbering/numbering.module';
import { OperationsSettingsModule } from '../operations-settings/operations-settings.module';
import { ProviderClaimModule } from '../provider-claim/provider-claim.module';
import { ShowcaseLifecycleModule } from '../showcase/showcase-lifecycle.module';
import { ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    NumberingModule,
    ProviderClaimModule,
    EntitlementsModule,
    OperationsSettingsModule,
    // Suspending a business, or narrowing its service areas, has to take its
    // paid vitrin runs off the air in the same transaction — and offering on a
    // direct lead has to mark that lead answered in the transaction that
    // created the offer.
    ShowcaseLifecycleModule,
  ],
  controllers: [ProvidersController],
  providers: [ProvidersService],
  // The invitation flow writes its applications through this service rather
  // than through a second copy of the same rules. See ProviderInvitesModule.
  exports: [ProvidersService],
})
export class ProvidersModule {}
