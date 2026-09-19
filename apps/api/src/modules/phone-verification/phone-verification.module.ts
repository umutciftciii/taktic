import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { OperationsSettingsModule } from '../operations-settings/operations-settings.module';
import { ServiceRequestsModule } from '../service-requests/service-requests.module';
import { PhoneVerificationController } from './phone-verification.controller';
import { ProviderPhoneVerificationController } from './provider-phone-verification.controller';
import { PhoneVerificationService } from './phone-verification.service';

/**
 * `ServiceRequestsModule` is imported for one call: publishing the request a
 * verification has just unblocked, inside the verification's own transaction.
 * No cycle — that module reaches this one through nothing it imports (its
 * showcase edge is the lifecycle slice, not `ShowcaseModule`, which is the one
 * that imports both). `RequestPublishOutbox` arrives through the global
 * notifications module.
 */
@Module({
  imports: [PrismaModule, AuthModule, OperationsSettingsModule, ServiceRequestsModule],
  controllers: [PhoneVerificationController, ProviderPhoneVerificationController],
  providers: [PhoneVerificationService],
  exports: [PhoneVerificationService],
})
export class PhoneVerificationModule {}
