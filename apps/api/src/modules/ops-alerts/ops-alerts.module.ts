import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SystemHealthModule } from '../system-health/system-health.module';
import { OpsAlertDeliveryWorker } from './ops-alert-delivery.worker';
import { OpsAlertKeyRotationService } from './ops-alert-key-rotation.service';
import { OpsAlertRecipientsService } from './ops-alert-recipients.service';
import { OpsAlertEvaluator } from './ops-alert-evaluator.service';
import { OpsAlertRoutingService } from './ops-alert-routing.service';
import { TelegramAlertPort, TelegramBotApiAdapter } from './telegram-alert.port';

/**
 * OBS-ALERT-001. No controller: the engine only writes its own tables and
 * sends; what it found is read through `GET /system-health`, behind that
 * screen's permissions. There is no endpoint that triggers, acknowledges or
 * silences an alert, and nothing listens for Telegram.
 */
@Module({
  imports: [PrismaModule, NotificationsModule, SystemHealthModule],
  providers: [
    OpsAlertEvaluator,
    OpsAlertDeliveryWorker,
    OpsAlertRecipientsService,
    OpsAlertRoutingService,
    OpsAlertKeyRotationService,
    { provide: TelegramAlertPort, useFactory: () => new TelegramBotApiAdapter() },
  ],
  exports: [OpsAlertEvaluator, OpsAlertDeliveryWorker, OpsAlertRecipientsService, OpsAlertRoutingService, OpsAlertKeyRotationService, TelegramAlertPort],
})
export class OpsAlertsModule {}
