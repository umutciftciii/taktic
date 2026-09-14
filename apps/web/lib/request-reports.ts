/**
 * A provider's report on a request, as the panel names it.
 *
 * Client-safe on purpose: the dialog that renders the reasons is a Client
 * Component and cannot pull in `lib/api.ts` (which reaches for next/headers).
 * `lib/api.ts` re-exports these so server code keeps one import.
 */
export type RequestReportReason =
  | 'SPAM'
  | 'FAKE_OR_TEST'
  | 'CONTAINS_CONTACT_INFO'
  | 'WRONG_CATEGORY'
  | 'INAPPROPRIATE_CONTENT'
  | 'DUPLICATE'
  | 'OTHER';

/** Provider-facing wording, in the order the dialog lists them. */
export const REQUEST_REPORT_REASON_LABELS: Record<RequestReportReason, string> = {
  SPAM: 'Spam veya anlamsız içerik',
  FAKE_OR_TEST: 'Gerçek bir iş değil / deneme',
  CONTAINS_CONTACT_INFO: 'İletişim bilgisi içeriyor',
  WRONG_CATEGORY: 'Yanlış kategori',
  INAPPROPRIATE_CONTENT: 'Uygunsuz içerik',
  DUPLICATE: 'Aynı iş için tekrar talep',
  OTHER: 'Diğer',
};

export const REQUEST_REPORT_REASONS = Object.keys(
  REQUEST_REPORT_REASON_LABELS,
) as RequestReportReason[];

/** Mirrors REPORT_NOTE_MAX_LENGTH on the API side; the DTO is the authority. */
export const REQUEST_REPORT_NOTE_MAX_LENGTH = 500;

/** What this provider already said about a request, as the detail carries it. */
export type ProviderRequestReport = {
  reason: RequestReportReason;
  createdAt: string;
};
