import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ProvidersModule } from '../providers/providers.module';
import { CategoryProviderInvitesController } from './category-provider-invites.controller';
import { ProviderInvitesController } from './provider-invites.controller';
import { ProviderInvitesService } from './provider-invites.service';

/**
 * An invitation is a category fact and an application fact at once, so it lives
 * in its own module rather than inside either: CategoriesModule would gain a
 * dependency on provider onboarding, and ProvidersModule would gain routes
 * mounted under `/categories`.
 *
 * The application it produces is written by ProvidersService, not re-implemented
 * here. That is the point of the split — there is one definition of what a
 * provider application is, what it refuses and what it triggers, and the
 * invitation supplies exactly one thing on top of it: which category.
 */
@Module({
  imports: [PrismaModule, AuthModule, ProvidersModule],
  controllers: [ProviderInvitesController, CategoryProviderInvitesController],
  providers: [ProviderInvitesService],
  exports: [ProviderInvitesService],
})
export class ProviderInvitesModule {}
