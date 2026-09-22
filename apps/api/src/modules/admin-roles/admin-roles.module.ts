import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminMeController } from './admin-me.controller';
import { AdminRolesController } from './admin-roles.controller';
import { AdminRolesService } from './admin-roles.service';

/**
 * The root half of PR-0: defining roles, handing them out, and telling a
 * session what it holds. Nothing here is guarded by a permission, because
 * nothing here may be delegated (RG-7 §12.1).
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [AdminRolesController, AdminMeController],
  providers: [AdminRolesService],
  exports: [AdminRolesService],
})
export class AdminRolesModule {}
