import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthGuard, OptionalAuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { ProviderAccessGuard } from './provider-access.guard';
import { RolesGuard } from './roles.guard';

@Module({
  imports: [PrismaModule],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, OptionalAuthGuard, RolesGuard, ProviderAccessGuard],
  exports: [AuthService, AuthGuard, OptionalAuthGuard, RolesGuard, ProviderAccessGuard],
})
export class AuthModule {}
