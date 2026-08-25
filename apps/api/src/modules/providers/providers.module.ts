import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { NumberingModule } from '../numbering/numbering.module';
import { ProviderClaimModule } from '../provider-claim/provider-claim.module';
import { ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';

@Module({
  imports: [PrismaModule, AuthModule, NumberingModule, ProviderClaimModule],
  controllers: [ProvidersController],
  providers: [ProvidersService],
})
export class ProvidersModule {}
