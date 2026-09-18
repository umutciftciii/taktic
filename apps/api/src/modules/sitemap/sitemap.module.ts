import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { CategoriesModule } from '../categories/categories.module';
import { SitemapController } from './sitemap.controller';
import { SitemapService } from './sitemap.service';

/**
 * The sitemap's data. Imports the categories module for its public listing;
 * the provider and vitrin rules it needs are pure functions, so it reaches
 * neither of those modules and sits in no cycle.
 */
@Module({
  imports: [PrismaModule, CategoriesModule],
  controllers: [SitemapController],
  providers: [SitemapService],
})
export class SitemapModule {}
