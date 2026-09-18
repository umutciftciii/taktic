import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { CategoriesModule } from '../categories/categories.module';
import { SeoModule } from '../seo/seo.module';
import { SitemapController } from './sitemap.controller';
import { SitemapService } from './sitemap.service';

/**
 * The sitemap's data. Imports the categories module for its public listing
 * and the SEO module for index eligibility; neither reaches the provider or
 * vitrin modules, so this sits in no cycle.
 */
@Module({
  imports: [PrismaModule, CategoriesModule, SeoModule],
  controllers: [SitemapController],
  providers: [SitemapService],
})
export class SitemapModule {}
