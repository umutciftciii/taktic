import { formatDate, type ShowcaseCardPublication, type ShowcasePublicationState } from '../../../../lib/api';

/**
 * How one card reads on the provider's own screen: one sentence about where it
 * stands, and one thing to do about it.
 *
 * ## What this replaced, and why
 *
 * The panel used to describe a card with a status badge, a second badge for the
 * version under review, a sentence naming both version numbers, a separate
 * "Vitrin yayını" box with the placement's raw state in it, and — when the sale
 * terms had not been accepted for this card — a notice saying the terms had been
 * updated. Five statements about one card, in five vocabularies, three of them
 * borrowed straight from the schema.
 *
 * A provider does not have a mental model with `ShowcasePlacement`,
 * `PENDING_ACTIVATION` and "sürüm 3" in it, and they should not have to build
 * one. They have a card, and it is either being worked on, being read, waiting
 * for money, on the air, or finished. So the API resolves the state (see
 * `ShowcasePublicationService`) and this turns it into the two strings a person
 * acts on.
 *
 * ## The action is a promise
 *
 * Every label here is a verb the provider can actually perform on the screen the
 * href leads to. A state with nothing to do about it — theirs to wait on, or an
 * operator's to lift — returns no action at all rather than a disabled button,
 * because a button that cannot be pressed is a screen asking somebody to try.
 */
export type ShowcaseStage = {
  /** Where the card stands, in one line. */
  label: string;
  /** Why it is there and what happens next, when that is not obvious. */
  detail: string | null;
  /** The single next thing to do, or null when there is nothing to do. */
  action: { label: string; href: string } | null;
};

export function showcaseStage(
  publication: ShowcaseCardPublication | undefined,
  cardHref: string,
  providerId: string,
): ShowcaseStage {
  // A card the publication endpoint could not answer for is treated as a plain
  // draft rather than as a broken row: the card screen itself is still reachable
  // and still authoritative.
  const state: ShowcasePublicationState = publication?.state ?? 'DRAFT';
  const edit = { label: 'Kartı düzenle', href: cardHref };

  switch (state) {
    case 'DRAFT':
      return {
        label: 'Taslak',
        detail: 'Kartınız henüz kimseye gösterilmiyor.',
        action: { label: 'İncelemeye gönder', href: cardHref },
      };

    case 'IN_REVIEW':
      return {
        label: 'İnceleniyor',
        detail: 'Kartınız yönetimde. Sonuçlanana kadar değiştirilemez.',
        action: null,
      };

    case 'REJECTED':
      return {
        label: 'Reddedildi',
        detail: 'İnceleme notunu okuyup düzenledikten sonra yeniden gönderebilirsiniz.',
        action: edit,
      };

    case 'TERMS_REQUIRED':
      return {
        label: 'Şart onayı bekliyor',
        detail: 'Kartınız onaylandı. Yayına almadan önce hizmet bedeli şartlarını onaylayın.',
        action: { label: 'Şartları onayla', href: cardHref },
      };

    case 'READY_TO_PUBLISH':
      return {
        label: 'Yayına hazır',
        detail: 'Kartınız onaylandı. Bir paket seçtiğinizde vitrinde görünmeye başlar.',
        action: { label: 'Vitrine çıkar', href: cardHref },
      };

    case 'EXPIRED':
      return {
        label: 'Süresi doldu',
        detail: 'Vitrin süreniz sona erdi. Yeni bir paketle kartı tekrar yayına alabilirsiniz.',
        action: { label: 'Yeniden yayınla', href: cardHref },
      };

    case 'AWAITING_PAYMENT':
      return {
        label: 'Ödeme bekliyor',
        detail: 'Ödeme sayfanız hâlâ açık. Tamamladığınızda kartınız yayına girer.',
        /*
         * The hosted checkout itself when there is a usable one, so "continue"
         * genuinely continues rather than starting the purchase over — and the
         * purchase's own screen otherwise, which is where the in-app form
         * lives when the payment provider has no hosted page.
         */
        action: {
          label: 'Ödemeye devam et',
          href:
            publication?.checkoutUrl ??
            (publication?.purchaseId
              ? `/providers/${providerId}/package-purchases/${publication.purchaseId}`
              : cardHref),
        },
      };

    case 'ACTIVATING':
      return {
        label: 'Ödeme doğrulanıyor',
        detail: 'Ödemeniz alındı. Onay ulaştığı anda kartınız yayına girecek.',
        action: null,
      };

    case 'LIVE':
      return {
        label: publication?.endAt ? `Yayında · ${formatDate(publication.endAt)}` : 'Yayında',
        detail: publication?.endAt
          ? `Kartınız ${formatDate(publication.endAt)} tarihine kadar vitrinde.`
          : 'Kartınız vitrinde.',
        action: null,
      };

    case 'PAUSED':
      return {
        label: 'Geçici olarak yayında değil',
        detail:
          'Kartınız şu anda vitrinde görünmüyor. Sebep ortadan kalktığında yayın kaldığı ' +
          'yerden devam eder ve durduğu süre yayın sürenize eklenir.',
        action: null,
      };

    case 'ARCHIVED':
      return {
        label: 'Arşivde',
        detail: 'Kart yayında değil ve yeni talep almıyor.',
        action: { label: 'Arşivden çıkar', href: cardHref },
      };

    case 'SUSPENDED':
      return {
        label: 'Yönetim tarafından durduruldu',
        detail: 'Kartınız yayından kaldırıldı. Destek ekibiyle iletişime geçebilirsiniz.',
        action: null,
      };
  }
}

/**
 * The badge colour for a state.
 *
 * Three families only — on the air, in motion, needs you — because a palette
 * with a colour per state is a palette nobody learns.
 */
export function showcaseStageBadgeClass(
  publication: ShowcaseCardPublication | undefined,
): string {
  switch (publication?.state ?? 'DRAFT') {
    case 'LIVE':
      return 'pdash-badge pdash-badge-success';
    case 'IN_REVIEW':
    case 'ACTIVATING':
    case 'AWAITING_PAYMENT':
      return 'pdash-badge pdash-badge-info';
    case 'REJECTED':
    case 'SUSPENDED':
    case 'PAUSED':
      return 'pdash-badge pdash-badge-danger';
    default:
      return 'pdash-badge pdash-badge-muted';
  }
}
