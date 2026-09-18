import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SeoIndexEligibilityService } from './seo-index-eligibility.service';

/**
 * Index eligibility. Reaches PrismaModule and two pure files (the provider
 * visibility allow-list and the vitrin "on the air" predicate), so the
 * modules that import it — vitrin, sitemap — sit in no cycle.
 */
@Module({
  imports: [PrismaModule],
  providers: [SeoIndexEligibilityService],
  exports: [SeoIndexEligibilityService],
})
export class SeoModule {}
