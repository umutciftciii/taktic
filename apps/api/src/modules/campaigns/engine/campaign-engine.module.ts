import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { CampaignFactReader } from './campaign-fact-reader';
import { CampaignEngineHooks } from './campaign-engine.hooks';
import { CampaignEngineRepository } from './campaign-engine.repository';
import { CampaignEngineService } from './campaign-engine.service';
import { FactSourceRegistry } from './fact-source-registry';

/**
 * The campaign engine and its one door (CMP-002 S2B2).
 *
 * Imports only Prisma, so any domain module — providers, e-mail and phone
 * proof, payments, package purchases — can import it without a cycle
 * (`CampaignsModule` needs `AuthModule`, and `AuthModule` needs the e-mail
 * proof module, which is why the engine and the admin API are two modules).
 *
 * Exports `CampaignEngineHooks`, through which the writers of the three facts
 * and the two settlement paths call the engine from inside their own
 * transactions, and `FactSourceRegistry`, which the admin API's activation
 * gate reads. `CampaignEngineService` and the repository stay internal: no
 * route, scheduler or other service can evaluate or grant directly.
 */
@Module({
  imports: [PrismaModule],
  providers: [CampaignEngineRepository, CampaignFactReader, FactSourceRegistry, CampaignEngineService, CampaignEngineHooks],
  exports: [CampaignEngineHooks, FactSourceRegistry],
})
export class CampaignEngineModule {}
