import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ContactSharingController } from './contact-sharing.controller';
import { ContactSharingService } from './contact-sharing.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ContactSharingController],
  providers: [ContactSharingService],
})
export class ContactSharingModule {}
