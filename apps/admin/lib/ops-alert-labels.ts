/**
 * The operations-alert channel and delivery words (OBS-ALERT-001/002), on
 * their own so a client component can use them: `lib/system-health.ts` also
 * reads `lib/api.ts`, which imports `next/headers` and must never reach a
 * client bundle (test/client-boundary.spec.ts). `lib/system-health.ts`
 * re-exports everything here.
 */

export type OpsAlertChannel = 'TELEGRAM' | 'EMAIL';
export type OpsAlertDeliveryStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'ABANDONED' | 'CANCELLED';

export const OPS_ALERT_CHANNEL_LABELS: Record<OpsAlertChannel, string> = { TELEGRAM: 'Telegram', EMAIL: 'E-posta' };

export const OPS_ALERT_DELIVERY_LABELS: Record<OpsAlertDeliveryStatus, string> = {
  PENDING: 'Bekliyor',
  SENDING: 'Gönderiliyor',
  SENT: 'Gönderildi',
  FAILED: 'Yeniden denenecek',
  ABANDONED: 'Gönderilemedi',
  CANCELLED: 'İptal (sorun gönderilmeden düzeldi)',
};
