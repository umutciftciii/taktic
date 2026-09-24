import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { BusinessRegistrationController } from './business-registration.controller';
import { BusinessRegistrationService } from './business-registration.service';

/**
 * CMP-006 PR-C — the canonical business registration: the provider's own
 * declaration and the audited raw read. The application paths write through
 * the same `writeBusinessRegistration` function from ProvidersService.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [BusinessRegistrationController],
  providers: [BusinessRegistrationService],
})
export class BusinessRegistrationModule {}
