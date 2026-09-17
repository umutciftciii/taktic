/**
 * What the customer's own request surfaces say while the request waits for
 * the customer's proof of their telephone number (REQ-UX-010).
 *
 * The wait itself is the API's word: `awaitingPhoneVerification` on the
 * customer projection, true only while the gate is on, the number is unproven
 * and nothing has moved the request yet. Nothing here derives it from the
 * status column, and nothing here decides what verifying does — the API
 * publishes or hands the request to an operator in its own flow. These
 * sentences only say which of the two it will be, chosen by the same
 * fail-closed policy read the request form uses.
 */

import { formatDateTime } from './request-formatters';

/** The heading the verify receipt and the card share. */
export const VERIFY_PHONE_TITLE = 'Telefonunuzu doğrulayın';

/** Anchor of the verification card on the request's own page. */
export const PHONE_VERIFICATION_ANCHOR = 'telefon-dogrulama';

const PUBLISH_AFTER_VERIFY =
  'Doğrulama tamamlandığında talebiniz bölgenizdeki uygun hizmet verenlere iletilir ve 14 gün boyunca teklif alır.';
const REVIEW_AFTER_VERIFY =
  'Doğrulama tamamlandığında talebiniz ön incelemeye alınır; onay sonrasında bölgenizdeki uygun hizmet verenlere iletilir ve 14 gün boyunca teklif alır.';

/**
 * What happens once the number is proven. The review sentence is the promise
 * the platform can keep whatever the switch says, so it is the fallback.
 */
export function afterVerificationSentence(autoPublishEnabled: boolean): string {
  return autoPublishEnabled ? PUBLISH_AFTER_VERIFY : REVIEW_AFTER_VERIFY;
}

/** Display-only mask; the server never sends the full number back either. */
export function maskPhoneForDisplay(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) {
    return '***';
  }
  return `${digits.slice(0, 3)}${'*'.repeat(Math.max(digits.length - 5, 0))}${digits.slice(-2)}`;
}

/** The slice of the customer's request these words are chosen from. */
export type RequestLifecycleView = {
  status: string;
  offersCount: number;
  submittedAt: string;
  expiredAt: string | null;
  awaitingPhoneVerification?: boolean;
  /** When the request went live; null while it has not. */
  approvedAt?: string | null;
  /** When an operator last moderated it; null on a request nobody moderated. */
  moderatedAt?: string | null;
};

const NO_SUMMARY_TEXT =
  'Bu talebe ait özet bilgileri görüntülenemiyor. Talebiniz başka bir hesaptan oluşturulmuş olabilir.';

/**
 * The one sentence under "Talep özeti" on the request's own page.
 *
 * A request waiting for the customer's proof has reached nobody yet and says
 * so; a request waiting for an operator is in review; everything from
 * APPROVED on keeps the sentence it always had.
 */
export function requestSummaryBody(
  summary: RequestLifecycleView | null,
  autoPublishEnabled: boolean,
): string {
  if (!summary) {
    return NO_SUMMARY_TEXT;
  }

  if (summary.awaitingPhoneVerification === true) {
    return `Talebiniz henüz hizmet verenlere iletilmedi. Devam etmesi için aşağıdan telefon numaranızı doğrulayın. ${afterVerificationSentence(autoPublishEnabled)}`;
  }

  if (summary.status === 'MATCHED') {
    return 'Bir teklifi kabul ettiniz. Talebiniz artık yeni teklif almıyor. Hizmet tamamlandığında aşağıdan işaretleyebilirsiniz.';
  }

  if (summary.status === 'COMPLETED') {
    return 'Bu talep tamamlandı olarak işaretlendi.';
  }

  // Neutral and factual: the window closed, and that is all it means.
  if (summary.status === 'EXPIRED') {
    return summary.expiredAt
      ? `Talebin geçerlilik süresi ${formatDateTime(summary.expiredAt)} tarihinde doldu. Talep artık yeni teklif almıyor; daha önce gelen teklifleri aşağıda görebilirsiniz.`
      : 'Talebin geçerlilik süresi doldu. Talep artık yeni teklif almıyor; daha önce gelen teklifleri aşağıda görebilirsiniz.';
  }

  // Waiting for an operator: it has not been forwarded to anybody yet either.
  if (summary.status === 'SUBMITTED' || summary.status === 'IN_REVIEW') {
    return 'Talebiniz ön incelemede. Onay sonrasında bölgenizdeki uygun hizmet verenlere iletilir ve teklifler bu sayfada görünür.';
  }

  return 'Talebiniz hizmet verenlere iletildi. Aşağıdaki kartlarda gelen teklifleri inceleyebilirsiniz.';
}

export type RequestTimelineStep = {
  title: string;
  done: boolean;
  meta?: string | null;
};

/**
 * The "Süreç" rail. A request waiting for the customer's proof gets a
 * verification step in front of everything else, and — under instant
 * publish, where no operator follows — no review step at all, so the rail
 * never promises a review that will not happen.
 *
 * The second step is named by what really happened to the request, read off
 * the row's own timestamps: approved with nobody moderating it — born live on
 * a proven number, or published by the customer's own verification — is
 * "Yayına alındı", not a review that never took place. A request an operator
 * moderated, and every request still waiting for one, keeps "Ön inceleme".
 */
export function requestTimelineSteps(
  summary: RequestLifecycleView | null,
  autoPublishEnabled: boolean,
): RequestTimelineStep[] {
  const waiting = summary?.awaitingPhoneVerification === true;
  const publishedUnmoderated =
    Boolean(summary?.approvedAt) && summary?.moderatedAt === null;
  const reviewStep: RequestTimelineStep = {
    title: publishedUnmoderated ? 'Yayına alındı' : 'Ön inceleme',
    done: Boolean(summary && !waiting && summary.status !== 'SUBMITTED' && summary.status !== 'IN_REVIEW'),
  };

  return [
    { title: 'Talep alındı', done: true, meta: summary ? formatDateTime(summary.submittedAt) : null },
    ...(waiting ? [{ title: 'Telefon doğrulama', done: false, meta: 'Sizi bekliyor' }] : []),
    ...(waiting && autoPublishEnabled ? [] : [reviewStep]),
    {
      title: 'Teklif toplama',
      done: Boolean(summary && summary.offersCount > 0),
      meta: summary ? `${summary.offersCount} teklif` : null,
    },
    { title: 'Eşleşme', done: summary?.status === 'MATCHED' || summary?.status === 'COMPLETED' },
  ];
}

/**
 * The card's own paragraph. Required: the request goes nowhere without the
 * proof, and the sentence says where it goes with it. Optional: the invitation
 * it always was, with no claim that anything depends on it.
 */
export function phoneVerificationCardCopy({
  required,
  maskedPhone,
  autoPublishEnabled,
}: {
  required: boolean;
  maskedPhone: string;
  autoPublishEnabled: boolean;
}): string {
  if (required) {
    return `Talebinizin ilerlemesi için ${maskedPhone} numarasını doğrulamanız gerekiyor. ${afterVerificationSentence(autoPublishEnabled)}`;
  }

  return `${maskedPhone} numarasını doğrulayarak talebinizin bize doğru ulaştığını teyit edebilirsiniz. Doğrulama şu anda zorunlu değildir ve talebiniz normal şekilde ilerler.`;
}

const NO_OFFERS_REACHED_TEXT =
  'Talebiniz hizmet verenlere ulaştı. Teklifler geldikçe burada görüntülenecektir.';

/**
 * The sentence under "Henüz teklif gelmedi". A request nobody has been shown
 * yet must not say it reached them: while it waits for the customer's proof
 * it says so, while it waits for an operator it says that, and only a live
 * request keeps the sentence it always had. `null` — no summary — keeps the
 * old sentence too, as the page did before.
 */
export function noOffersYetText(summary: RequestLifecycleView | null): string {
  if (summary?.awaitingPhoneVerification === true) {
    return 'Talebiniz henüz hizmet verenlere iletilmedi. Telefonunuzu doğruladıktan sonra gelen teklifler burada görüntülenir.';
  }

  if (summary && (summary.status === 'SUBMITTED' || summary.status === 'IN_REVIEW')) {
    return 'Talebiniz ön incelemede. Onay sonrasında gelen teklifler burada görüntülenir.';
  }

  return NO_OFFERS_REACHED_TEXT;
}
