import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CreditsModule } from '../credits/credits.module';
import { NumberingModule } from '../numbering/numbering.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PackagePurchasesController } from './package-purchases.controller';
import { PackagePurchasesService } from './package-purchases.service';

@Module({
  imports: [PrismaModule, AuthModule, CreditsModule, NumberingModule],
  controllers: [PackagePurchasesController],
  providers: [PackagePurchasesService],
  exports: [PackagePurchasesService],
})
export class PackagePurchasesModule {}
