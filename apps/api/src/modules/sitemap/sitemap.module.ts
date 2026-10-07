import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SeoModule } from '../seo/seo.module';
import { SitemapController } from './sitemap.controller';
import { SitemapService } from './sitemap.service';

/**
 * The sitemap's data. Imports the SEO module for index eligibility, which
 * reads the categories, businesses and cards itself; it reaches no feature
 * module, so this sits in no cycle.
 */
@Module({
  imports: [PrismaModule, SeoModule],
  controllers: [SitemapController],
  providers: [SitemapService],
})
export class SitemapModule {}
