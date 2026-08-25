import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ProviderClaimController } from './provider-claim.controller';
import { ProviderClaimRateLimiter } from './provider-claim.rate-limiter';
import { ProviderClaimService } from './provider-claim.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ProviderClaimController],
  providers: [ProviderClaimService, ProviderClaimRateLimiter],
  exports: [ProviderClaimService, ProviderClaimRateLimiter],
})
export class ProviderClaimModule {}
