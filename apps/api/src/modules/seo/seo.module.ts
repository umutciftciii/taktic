import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SeoIndexEligibilityService } from './seo-index-eligibility.service';
import { SeoNotFoundRecorder } from './seo-not-found.recorder';
import { SeoRedirectGraphService } from './seo-redirect-graph.service';

/**
 * The SEO core every public module may depend on: index eligibility, the
 * redirect graph (a category slug change writes its 301 through it) and the
 * 404 recorder (the public lookups report to it). Reaches PrismaModule and
 * pure files only, so the modules that import it — categories, providers,
 * vitrin, sitemap — sit in no cycle. The admin and public SEO routes are
 * SeoAdminModule's.
 */
@Module({
  imports: [PrismaModule],
  providers: [SeoIndexEligibilityService, SeoRedirectGraphService, SeoNotFoundRecorder],
  exports: [SeoIndexEligibilityService, SeoRedirectGraphService, SeoNotFoundRecorder],
})
export class SeoModule {}
