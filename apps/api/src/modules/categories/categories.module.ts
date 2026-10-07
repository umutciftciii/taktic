import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SeoModule } from '../seo/seo.module';
import { ShowcaseLifecycleModule } from '../showcase/showcase-lifecycle.module';
import { AdminCategoriesController } from './admin-categories.controller';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';

@Module({
  // Closing a category takes the vitrin runs on that shelf off the air, in the
  // same transaction as the status change, and reopening it puts them back.
  // SEO-004: a slug change writes its 301 through the redirect graph, and a
  // public 404 is reported to the suggestion recorder.
  imports: [AuthModule, ShowcaseLifecycleModule, SeoModule],
  controllers: [CategoriesController, AdminCategoriesController],
  providers: [CategoriesService],
  // Request creation resolves its category through the same router walk the
  // public endpoint uses, so there is exactly one definition of where a routed
  // request lands.
  exports: [CategoriesService],
})
export class CategoriesModule {}
