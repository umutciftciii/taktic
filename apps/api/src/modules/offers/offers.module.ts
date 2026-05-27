import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { OffersController } from './offers.controller';
import { OffersService } from './offers.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [OffersController],
  providers: [OffersService],
  exports: [OffersService],
})
export class OffersModule {}
