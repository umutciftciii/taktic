import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { CustomerActivationController } from './customer-activation.controller';
import { CustomerActivationService } from './customer-activation.service';

@Module({
  imports: [PrismaModule],
  controllers: [CustomerActivationController],
  providers: [CustomerActivationService],
  exports: [CustomerActivationService],
})
export class CustomerActivationModule {}
