import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { CompanySettingsController } from './company-settings.controller';
import { CompanySettingsService } from './company-settings.service';

/**
 * Exported, because the notifications module resolves the footer from the same
 * service rather than reading the table itself — one definition of "complete
 * settings", used by the screen that fills them in and by the transport that
 * refuses to send without them.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [CompanySettingsController],
  providers: [CompanySettingsService],
  exports: [CompanySettingsService],
})
export class CompanySettingsModule {}
