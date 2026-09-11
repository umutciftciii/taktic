import { formatDate, type ShowcaseCardPublication } from '../../../../lib/api';

/**
 * How one card reads on the provider's own screen: a badge, one sentence, and
 * one thing to do about it.
 *
 * The API resolves the state (see `ShowcasePublicationService`); this turns it
 * into the strings a person acts on. Eight human labels cover ten machine
 * states on purpose — a provider has a card that is being worked on, being
 * read, waiting for a package, on the air, refused, lapsed, stopped or
 * archived, and does not need a vocabulary finer than that.
 *
 * Every action here is a verb the provider can actually perform. A state with
 * nothing to do about it — theirs to wait on, or an operator's to lift — returns
 * no action rather than a disabled button, because a button that cannot be
 * pressed is a screen asking somebody to try.
 */
export type ShowcaseStage = {
  /** The badge text: one of the six human states. */
  label: string;
  badge: 'live' | 'progress' | 'attention' | 'muted';
  /** One sentence under the badge, when the state is not self-explanatory. */
  detail: string | null;
  /** The single primary action, or null when the only thing to do is wait. */
  action: { label: string; href: string; kind: 'link' } | { label: string; kind: 'submit' | 'use-entitlement' } | null;
};

export function showcaseStage(
  entry: ShowcaseCardPublication | undefined,
  ctx: { providerId: string; cardId: string; hasAvailableRight: boolean },
): ShowcaseStage {
  const cardHref = `/providers/${ctx.providerId}/vitrin/${ctx.cardId}`;
  const buy = { label: 'Vitrin paketi al', href: `/providers/${ctx.providerId}/vitrin/paketler?card=${ctx.cardId}`, kind: 'link' as const };
  const useRight = { label: 'Vitrine çıkar', kind: 'use-entitlement' as const };
  // Publish now when a spare right is on hand; otherwise the shop.
  const publishNow: ShowcaseStage['action'] = ctx.hasAvailableRight ? useRight : buy;

  // A card the publication endpoint could not answer for is treated as a plain
  // draft rather than as a broken row: the card screen itself is still
  // reachable and still authoritative.
  switch (entry?.state ?? 'DRAFT') {
    case 'DRAFT':
      return { label: 'Taslak', badge: 'muted', detail: 'Kartınız henüz kimseye gösterilmiyor.', action: { label: 'İncelemeye gönder', kind: 'submit' } };
    case 'IN_REVIEW':
      return { label: 'İncelemede', badge: 'progress', detail: 'Kartınız inceleniyor. Sonuçlanana kadar değiştirilemez.', action: null };
    case 'REJECTED':
      return entry?.needsPackage
        ? { label: 'Reddedildi', badge: 'attention', detail: 'Yayın hakkınızın süresi dolduğu için yeniden göndermek üzere paket almanız gerekiyor.', action: buy }
        : { label: 'Reddedildi', badge: 'attention', detail: 'İnceleme notunu okuyup düzenledikten sonra yeniden gönderebilirsiniz.', action: { label: 'Düzenle ve yeniden gönder', href: `${cardHref}/duzenle`, kind: 'link' } };
    case 'NEEDS_PACKAGE':
      return { label: 'Pakete hazır', badge: 'muted', detail: 'Bu kartı incelemeye göndermek için bir vitrin hakkı gerekiyor.', action: publishNow };
    case 'EXPIRED':
      return entry?.hasRunBefore
        ? { label: 'Süresi doldu', badge: 'muted', detail: 'Vitrin süreniz sona erdi. Yeni bir paketle kartı tekrar yayına alabilirsiniz.', action: ctx.hasAvailableRight ? { label: 'Yeniden yayınla', kind: 'use-entitlement' } : { ...buy, label: 'Yeniden yayınla' } }
        : { label: 'Pakete hazır', badge: 'muted', detail: 'Kartınız onaylı. Bir vitrin hakkıyla hemen yayına girer.', action: publishNow };
    case 'ACTIVATING':
      return { label: 'Yayında', badge: 'live', detail: 'Kartınız yayına alınıyor.', action: null };
    case 'LIVE':
      return { label: 'Yayında', badge: 'live', detail: entry?.endAt ? `${formatDate(entry.endAt)} tarihine kadar vitrinde.` : null, action: { label: 'Yayını görüntüle', href: `/vitrin/${ctx.cardId}`, kind: 'link' } };
    case 'PAUSED':
      return { label: 'Yayında', badge: 'progress', detail: 'Kartınız geçici olarak görünmüyor; sebep ortadan kalkınca kaldığı yerden devam eder.', action: null };
    case 'ARCHIVED':
      return { label: 'Arşivde', badge: 'muted', detail: 'Kart yayında değil ve yeni talep almıyor.', action: null };
    case 'SUSPENDED':
      return { label: 'Yayında değil', badge: 'attention', detail: 'Kartınız yönetim tarafından durduruldu. Destek ekibiyle iletişime geçebilirsiniz.', action: null };
  }
}
