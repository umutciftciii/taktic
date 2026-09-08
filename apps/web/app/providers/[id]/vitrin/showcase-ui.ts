import type { ShowcaseCard, ShowcaseCardStatus, ShowcaseVersionReview } from '../../../../lib/api';

/**
 * How a card's state reads on the provider's own screen.
 *
 * The card carries two versions at once, and the sentence a provider needs is
 * about both: "onaylı, yeni sürüm incelemede" is a different situation from
 * "onaylı" and from "incelemede", and a badge derived from `status` alone cannot
 * say which one they are in.
 */

export function showcaseStatusBadgeClass(status: ShowcaseCardStatus): string {
  switch (status) {
    case 'APPROVED':
      return 'pdash-badge pdash-badge-success';
    case 'PENDING_REVIEW':
      return 'pdash-badge pdash-badge-info';
    case 'REJECTED':
    case 'SUSPENDED':
      return 'pdash-badge pdash-badge-danger';
    default:
      return 'pdash-badge pdash-badge-muted';
  }
}

export function showcaseReviewBadgeClass(review: ShowcaseVersionReview): string {
  switch (review) {
    case 'APPROVED':
      return 'pdash-badge pdash-badge-success';
    case 'PENDING':
      return 'pdash-badge pdash-badge-info';
    case 'REJECTED':
      return 'pdash-badge pdash-badge-danger';
    default:
      return 'pdash-badge pdash-badge-muted';
  }
}

/**
 * One sentence about where the card stands, covering the pair of versions rather
 * than either one alone.
 *
 * Nothing here promises publication. In this phase an approved card is a
 * reviewed text and nothing more: no package, no placement, no customer surface.
 * The wording says "yayına hazır" and never "yayında", because saying the second
 * would be telling a provider their card is somewhere a visitor can see it.
 */
export function showcaseCardSituation(card: ShowcaseCard): string {
  const pendingDraft = card.draftVersion?.reviewStatus === 'PENDING';

  if (card.status === 'SUSPENDED') return 'Kart yönetim tarafından askıya alındı.';
  if (card.status === 'ARCHIVED') return 'Kart arşivlendi.';

  if (card.liveVersion && pendingDraft) {
    return `Onaylı sürüm ${card.liveVersion.versionNumber} yayına hazır; sürüm ${card.draftVersion?.versionNumber} incelemede.`;
  }
  if (card.liveVersion && card.draftVersion) {
    return `Onaylı sürüm ${card.liveVersion.versionNumber} yayına hazır; sürüm ${card.draftVersion.versionNumber} taslak hâlinde.`;
  }
  if (card.liveVersion) {
    return `Onaylı sürüm ${card.liveVersion.versionNumber} yayına hazır.`;
  }
  if (pendingDraft) return 'İlk sürüm incelemede.';
  if (card.status === 'REJECTED') return 'İlk sürüm reddedildi. Düzenleyip yeniden gönderebilirsiniz.';
  return 'Taslak. İncelemeye göndermediniz.';
}

/** The version the edit form should open on: the draft if there is one, else the live one. */
export function editableVersion(card: ShowcaseCard) {
  return card.draftVersion ?? card.liveVersion;
}

/** The most recent rejection the provider still needs to read, or null. */
export function lastRejection(card: ShowcaseCard) {
  const candidates = [card.draftVersion, card.liveVersion];
  for (const version of candidates) {
    if (version?.review?.decision === 'REJECTED') {
      return version.review;
    }
  }
  return null;
}
