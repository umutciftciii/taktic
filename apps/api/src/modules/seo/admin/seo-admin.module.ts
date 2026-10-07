import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuthModule } from '../../auth/auth.module';
import { CategoriesModule } from '../../categories/categories.module';
import { OperationsSettingsModule } from '../../operations-settings/operations-settings.module';
import { SeoModule } from '../seo.module';
import { SeoAdminController } from './seo-admin.controller';
import { SeoAdminService } from './seo-admin.service';
import { SeoPublicController } from './seo-public.controller';
import { SeoRetentionScheduler } from './seo-retention.scheduler';

/**
 * SEO-004 — the SEO routes: the admin API (`/admin/seo/*`), the web
 * middleware's redirect snapshot (`/seo/redirects/active`) and the 404
 * suggestions' retention job. Separate from SeoModule so the public modules
 * that need the SEO core do not pull in the admin surface.
 */
@Module({
  imports: [PrismaModule, AuthModule, CategoriesModule, OperationsSettingsModule, SeoModule],
  controllers: [SeoAdminController, SeoPublicController],
  providers: [SeoAdminService, SeoRetentionScheduler],
})
export class SeoAdminModule {}
