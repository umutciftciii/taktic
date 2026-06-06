import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { CustomerActivationModule } from '../customer-activation/customer-activation.module';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  imports: [PrismaModule, AuthModule, CustomerActivationModule],
  controllers: [CustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
