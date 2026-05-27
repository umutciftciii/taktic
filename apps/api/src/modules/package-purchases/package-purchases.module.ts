import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CreditsModule } from '../credits/credits.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PackagePurchasesController } from './package-purchases.controller';
import { PackagePurchasesService } from './package-purchases.service';

@Module({
  imports: [PrismaModule, AuthModule, CreditsModule],
  controllers: [PackagePurchasesController],
  providers: [PackagePurchasesService],
})
export class PackagePurchasesModule {}
