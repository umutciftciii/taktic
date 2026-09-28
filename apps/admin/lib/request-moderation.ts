/**
 * Which moderation moves the request screen offers ("İncelemeye al",
 * "Onayla"), by the request's current status.
 *
 * Moderation is the pre-market queue: a request the customer has sent
 * (SUBMITTED) is reviewed (IN_REVIEW) and published (APPROVED), and an
 * operator may move it between those three. Every other status belongs to a
 * flow of its own, and the screen does not offer a moderation move out of it:
 *
 * - DRAFT: the customer has not sent it yet.
 * - MATCHED, COMPLETED: a customer accepted an offer. Re-approving would put
 *   a matched request back on the market while it still points at the accepted
 *   offer.
 * - REJECTED: taken off the market with its offers closed and refunded; a
 *   report removal is put back through "Talebi geri aç" (REQUESTS_REOPEN), not
 *   through moderation.
 * - CANCELLED, EXPIRED: closed.
 *
 * The API enforces the same rule since API-GUARD-REQUEST-001 (PR #119):
 * `PATCH /service-requests/:id/status` accepts IN_REVIEW and APPROVED only
 * from these three states with no accepted offer, and refuses anything else
 * with 409 REQUEST_STATUS_TRANSITION_NOT_ALLOWED. This list only decides which
 * buttons are drawn; a row that moved after the page was drawn is refused by
 * the API and explained on the screen (lib/status-conflicts.ts).
 */

export type ModerationTarget = 'IN_REVIEW' | 'APPROVED';

/** The statuses a moderation move may start from. */
export const MODERATION_SOURCE_STATUSES: ReadonlySet<string> = new Set(['SUBMITTED', 'IN_REVIEW', 'APPROVED']);

/** Whether the request is in the moderation queue at all. */
export function isInModeration(status: string): boolean {
  return MODERATION_SOURCE_STATUSES.has(status);
}

/**
 * How one moderation button is drawn: `hidden` outside the queue, `current`
 * (shown, disabled, "Mevcut") when the request is already there, `available`
 * otherwise.
 */
export function moderationMove(current: string, target: ModerationTarget): 'hidden' | 'current' | 'available' {
  if (!isInModeration(current)) return 'hidden';
  return current === target ? 'current' : 'available';
}

/**
 * The statuses a request can be rejected or report-removed from, while no
 * offer is accepted on it. Mirrors `ServiceRequestsService.REMOVABLE_STATUSES`
 * plus the `matchedOfferId: null` condition of `rejectRequestInTransaction`
 * (API-GUARD-REQUEST-002, PR #120); the API decides, this only draws.
 */
const REMOVABLE_STATUSES: ReadonlySet<string> = new Set(['APPROVED', 'IN_REVIEW', 'SUBMITTED']);

export function isRemovable(status: string, matchedOfferId: string | null): boolean {
  return REMOVABLE_STATUSES.has(status) && matchedOfferId === null;
}

/**
 * Why a request cannot be rejected or removed, and what — if anything — the
 * API still lets an operator do with it. Null when it can be removed.
 *
 * - a closed request (COMPLETED, CANCELLED, EXPIRED, REJECTED) cannot be
 *   cancelled either — `POST /:id/cancel` refuses every terminal status — and
 *   is answered as closed even when it still carries `matchedOfferId`;
 * - a matched request is ended by the operations cancel (REQUESTS_CANCEL),
 *   whose consequences are now decided (PR #118 contract): the accepted offer
 *   closes, its credit comes back by default, losing offers are refunded,
 *   everyone is notified. The customer cannot cancel it;
 * - a draft has not been sent and takes no offers.
 */
export function removalUnavailableReason(status: string, matchedOfferId: string | null): string | null {
  if (isRemovable(status, matchedOfferId)) return null;

  // Closed first, whatever the row still points at: a COMPLETED, CANCELLED,
  // EXPIRED or REJECTED request keeps `matchedOfferId` as the record of a
  // match, and none of them can be cancelled (PR #118 review, item 6).
  switch (status) {
    case 'REJECTED':
      return 'Talep zaten reddedilmiş; yayında değil. Şikayet sonucu kaldırıldıysa Şikayet sekmesinden geri açılabilir.';
    case 'COMPLETED':
      return 'Talep tamamlandı. Kapanmış talep reddedilemez, kaldırılamaz ve iptal edilemez; bu ekrandan yapılabilecek bir durum işlemi yok.';
    case 'CANCELLED':
      return 'Talep iptal edildi. Kapanmış talep reddedilemez, kaldırılamaz ve yeniden açılamaz; bu ekrandan yapılabilecek bir durum işlemi yok.';
    case 'EXPIRED':
      return 'Talebin süresi doldu. Kapanmış talep reddedilemez, kaldırılamaz ve iptal edilemez; bu ekrandan yapılabilecek bir durum işlemi yok.';
  }

  if (status === 'MATCHED' || matchedOfferId !== null) {
    return 'Talep bir teklifle eşleşmiş; eşleşmiş talep reddedilemez ve şikayetle kaldırılamaz. Eşleşmeyi sonlandıran işlem, iptal yetkisi olan yöneticinin “İptal et” işlemidir: kabul edilen teklif kapatılır, kazanan teklifin kredisi varsayılan olarak iade edilir (iadesiz iptal ayrı yetki ve gerekçe ister), kazanamayan tekliflerin kredileri iade edilir ve taraflara bildirim gider. Müşteri eşleşmiş talebi iptal edemez.';
  }

  if (status === 'DRAFT') {
    return 'Talep henüz müşteri tarafından gönderilmedi (taslak). Taslak reddedilemez ve şikayetle kaldırılamaz; teklif almadığı için kapatılacak teklif ya da iade edilecek kredi de yok. İptal yetkisi olan yönetici taslağı “İptal et” ile kapatabilir.';
  }

  return 'Talep bu durumdan reddedilemez ve şikayetle kaldırılamaz.';
}
