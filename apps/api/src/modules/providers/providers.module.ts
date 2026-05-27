import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ProvidersController],
  providers: [ProvidersService],
})
export class ProvidersModule {}
