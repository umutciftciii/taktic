import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  formatPrice,
  SHOWCASE_CARD_KIND_LABELS,
  type ShowcaseCard,
  type ShowcaseCardKind,
  type ShowcaseCardVersion,
  type ShowcaseFeedCard,
} from '../lib/api';
import { categoryImageSrc } from './category-art';

/**
 * The one face a vitrin card has.
 *
 * The home page shelf, the provider's own grid, the card's summary screen and
 * the public card page all draw this. That is the design's whole argument: a
 * provider is not managing a record, they are looking at the exact thing a
 * customer will see — and if the two ever differed, one of them would be lying.
 *
 * The area band is the loudest line after the title on purpose. The shelf is
 * shown to visitors who chose no location, so "is this card for me" is decided
 * by that band before the title is read.
 */
export type ShowcaseFaceData = {
  kind: ShowcaseCardKind;
  categoryName: string;
  categorySlug?: string | null;
  title: string;
  summary: string;
  imageUrl: string | null;
  listedServicePriceAmount?: number | null;
  listedServiceCurrency?: string;
  areaLabels: string[];
  providerName?: string | null;
};

export function ShowcaseCardFace({
  card,
  href,
  badge,
  compact = false,
  className,
  testId,
}: {
  card: ShowcaseFaceData;
  /** Wraps the title in a link when given. */
  href?: string;
  /** A state badge, rendered over the media area. Provider screens only. */
  badge?: ReactNode;
  compact?: boolean;
  className?: string;
  testId?: string;
}) {
  const art = card.imageUrl ?? categoryImageSrc(null, card.categorySlug ?? null);
  const areas = card.areaLabels.length > 0 ? card.areaLabels.join(' · ') : 'Bölge belirtilmedi';

  return (
    <article className={['vitrin-face', compact && 'vitrin-face-compact', className].filter(Boolean).join(' ')} data-testid={testId}>
      <div className={art ? 'vitrin-face-media' : 'vitrin-face-media vitrin-face-media-empty'} aria-hidden="true">
        {art ? <img src={art} alt="" loading="lazy" /> : null}
      </div>
      {/* Beside the media rather than inside it: the picture is decoration, the state is not. */}
      {badge ? <span className="vitrin-face-badge">{badge}</span> : null}
      <div className="vitrin-face-body">
        <p className="vitrin-face-kicker">
          <span>{card.categoryName}</span>
          <span className="vitrin-face-kind">{SHOWCASE_CARD_KIND_LABELS[card.kind]}</span>
        </p>
        <h3 className="vitrin-face-title">{href ? <Link href={href}>{card.title}</Link> : card.title}</h3>
        {card.providerName ? <p className="vitrin-face-provider">{card.providerName}</p> : null}
        {typeof card.listedServicePriceAmount === 'number' ? (
          <p className="vitrin-face-price" data-testid="showcase-card-price">
            {formatPrice(card.listedServicePriceAmount, card.listedServiceCurrency ?? 'TRY')}
            <span> · sabit hizmet bedeli</span>
          </p>
        ) : null}
        {!compact ? <p className="vitrin-face-summary">{card.summary}</p> : null}
        <p className="vitrin-face-area" data-testid="showcase-card-area">
          <span className="vitrin-face-area-label">Hizmet bölgesi</span>
          <span aria-hidden="true"> · </span>
          <span className="vitrin-face-area-value">{areas}</span>
        </p>
      </div>
    </article>
  );
}

export function faceFromFeedCard(card: ShowcaseFeedCard): ShowcaseFaceData {
  return {
    kind: card.kind,
    categoryName: card.category.name,
    categorySlug: card.category.slug,
    title: card.title,
    summary: card.summary,
    imageUrl: card.imageUrl,
    listedServicePriceAmount: card.listedServicePriceAmount ?? null,
    listedServiceCurrency: card.listedServiceCurrency,
    areaLabels: card.areas.length > 0 ? card.areas.map((area) => area.label) : [card.areaLabel],
    providerName: card.provider.businessName,
  };
}

export function faceFromVersion(
  card: Pick<ShowcaseCard, 'kind' | 'category'>,
  version: ShowcaseCardVersion,
): ShowcaseFaceData {
  return {
    kind: card.kind,
    categoryName: card.category.name,
    categorySlug: card.category.slug,
    title: version.title,
    summary: version.summary,
    imageUrl: version.imageUrl,
    listedServicePriceAmount: version.listedServicePriceAmount,
    listedServiceCurrency: version.listedServiceCurrency,
    areaLabels: version.areas.map((area) => area.label),
  };
}
