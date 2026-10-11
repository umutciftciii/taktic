import limits from '../../../packages/shared/limits.json';
import type { ServiceIssueReason } from './api';

/**
 * REL-002 Faz 3 — the customer's service-issue words. The rules themselves
 * (which reason is open when) are the API's: the screen renders
 * `serviceIssue` from `GET /service-requests/my/:id` and never judges a date.
 */

export const SERVICE_ISSUE_NOTE_MIN_LENGTH: number = limits.serviceIssueNoteMinLength;
export const SERVICE_ISSUE_NOTE_MAX_LENGTH: number = limits.serviceIssueNoteMaxLength;

export const SERVICE_ISSUE_REASON_LABELS: Record<ServiceIssueReason, string> = {
  PROVIDER_NO_SHOW: 'Hizmet veren gelmedi',
  WORK_NOT_STARTED: 'İş başlamadı',
  WORK_NOT_COMPLETED: 'İş tamamlanmadı',
  PROVIDER_STOPPED_WORK: 'Hizmet veren işi yarıda bıraktı',
  PROVIDER_CANCELLED_BEFORE_START: 'Hizmet veren işi yapamayacağını bildirdi',
  OTHER: 'Diğer',
};

/** The reasons whose report needs the customer's own account of what happened. */
export const NOTE_REQUIRED_REASONS: ReadonlySet<ServiceIssueReason> = new Set([
  'OTHER',
  'PROVIDER_CANCELLED_BEFORE_START',
]);

export const SERVICE_ISSUE_CONSEQUENCE = {
  REOPEN: 'Bu eşleşme kapatılır ve talebiniz yeniden teklif almaya açılır.',
  ADMIN_REVIEW: 'Bu eşleşme kapatılır ve talebiniz ekibimiz tarafından incelenmek üzere beklemeye alınır.',
} as const;

export const SERVICE_ISSUE_IRREVERSIBLE = 'Bu işlem geri alınamaz.';

/** The API's refusals, in the customer's words. Anything else gets the generic sentence. */
const ERROR_MESSAGES: Record<string, string> = {
  REQUEST_NOT_MATCHED: 'Bu talepte şu anda devam eden bir eşleşme yok. Sayfayı yenileyin.',
  ROUND_CHANGED: 'Talebinizin durumu bu sayfa açıldıktan sonra değişti. Sayfayı yenileyip tekrar deneyin.',
  MATCH_INCONSISTENT: 'Bildiriminiz alınamadı. Lütfen destek ekibimizle iletişime geçin.',
  SERVICE_ISSUE_REQUIRES_SUPPORT:
    'Bu eşleşmede başlangıç ve bitiş tarihi bulunmadığı için sorun buradan bildirilemiyor. Lütfen destek ekibimizle iletişime geçin.',
  SERVICE_ISSUE_REASON_NOT_YET_AVAILABLE: 'Bu sebep henüz seçilemiyor; hizmet verenin taahhüt ettiği günün geçmesi gerekiyor.',
  SERVICE_ISSUE_NOTE_REQUIRED: `Bu sebep için en az ${SERVICE_ISSUE_NOTE_MIN_LENGTH} karakterlik bir açıklama yazın.`,
  SERVICE_ISSUE_NOTE_TOO_LONG: `Açıklama en fazla ${SERVICE_ISSUE_NOTE_MAX_LENGTH} karakter olabilir.`,
  IDEMPOTENCY_KEY_REUSED: 'Bu form eskidi. Lütfen pencereyi kapatıp yeniden açın.',
  ROUND_ALREADY_FAILED: 'Bu eşleşme için hizmet aksaklığı zaten bildirildi.',
  SERVICE_ISSUE_RATE_LIMITED: 'Kısa sürede çok fazla bildirim yapıldı. Lütfen biraz sonra tekrar deneyin.',
  CONCURRENT_MODIFICATION: 'Talebiniz aynı anda başka bir işlemle güncellendi. Sayfayı yenileyip tekrar deneyin.',
};

export const SERVICE_ISSUE_GENERIC_ERROR = 'Bildiriminiz şu anda alınamadı; eşleşme değişmedi. Lütfen tekrar deneyin.';

export function serviceIssueErrorMessage(code: string | null): string {
  return (code && ERROR_MESSAGES[code]) || SERVICE_ISSUE_GENERIC_ERROR;
}

/** The banner after a successful report (`?issue=`). */
export const SERVICE_ISSUE_OUTCOME_MESSAGES: Record<string, string> = {
  reopened: 'Bildiriminiz alındı. Eşleşme kapatıldı ve talebiniz yeniden teklif almaya açıldı.',
  'reopened-review': 'Bildiriminiz alındı. Eşleşme kapatıldı; talebiniz kısa bir incelemeden sonra yeniden teklif almaya açılacak.',
  review: 'Bildiriminiz alındı. Eşleşme kapatıldı; talebiniz ekibimiz tarafından inceleniyor.',
};
