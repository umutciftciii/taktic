import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SystemHealthModule } from '../system-health/system-health.module';
import { OpsAlertDeliveryWorker } from './ops-alert-delivery.worker';
import { OpsAlertKeyRotationService } from './ops-alert-key-rotation.service';
import { OpsAlertRecipientsController } from './ops-alert-recipients.controller';
import { OpsAlertRecipientsService } from './ops-alert-recipients.service';
import { OpsAlertEvaluator } from './ops-alert-evaluator.service';
import { OpsAlertRoutingController } from './ops-alert-routing.controller';
import { OpsAlertRoutingService } from './ops-alert-routing.service';
import { TelegramAlertPort, TelegramBotApiAdapter } from './telegram-alert.port';

/**
 * OBS-ALERT-001. The engine only writes its own tables and sends; what it
 * found is read through `GET /system-health`, behind that screen's
 * permissions. There is no endpoint that triggers, acknowledges or silences
 * an alert, and nothing listens for Telegram.
 *
 * OBS-ALERT-002 adds the two controllers that manage who receives alert
 * e-mail (`/ops-alerts/recipients`) and how it is routed
 * (`/ops-alerts/routing`), each verb behind its own OPS_ALERT_* permission.
 */
@Module({
  imports: [PrismaModule, AuthModule, NotificationsModule, SystemHealthModule],
  controllers: [OpsAlertRecipientsController, OpsAlertRoutingController],
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
