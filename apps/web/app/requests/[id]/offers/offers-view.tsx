'use client';

import Link from 'next/link';
import { useState } from 'react';
// Types only: `lib/api` reaches for next/headers and cannot be bundled here.
import type { OfferStatus, RequestOfferPreview } from '../../../../lib/api';
import {
  formatDate,
  formatDateTime,
  // The minor-unit formatter: offer amounts are stored in kuruş.
  formatPrice,
  statusLabel,
} from '../../../../lib/formatters';
import { IconArrowRight, IconClipList, IconCompare } from '../../../landing-icons';

type OffersViewProps = {
  requestId: string;
  /** Already filtered and sorted by the server: no withdrawn offers, price ascending. */
  offers: RequestOfferPreview[];
};

/**
 * The live offers, in two readings of the same data: a list and a side-by-side
 * table. Nothing is fetched here — the server handed over the exact set the
 * customer may act on, and switching view never changes it.
 */
export function OffersView({ requestId, offers }: OffersViewProps) {
  const [mode, setMode] = useState<'list' | 'compare'>('list');

  if (offers.length === 0) {
    return (
      <div className="cdash-empty">
        <h3>Henüz teklif gelmedi</h3>
        <p>Talebiniz hizmet verenlere ulaştı. Teklifler geldikçe burada görüntülenecektir.</p>
        <Link className="cdash-btn cdash-btn-secondary" href="/requests/my">
          Taleplere dön
        </Link>
      </div>
    );
  }

  // The cheapest offer, which is simply the first one after the server's sort.
  // With a single offer there is nothing to be cheapest *than*, so nothing is
  // marked.
  const lowestId = offers.length > 1 ? (offers[0]?.id ?? null) : null;

  return (
    <>
      <div className="cdash-section-head">
        <h2 className="cdash-section-title">
          <span>Gelen teklifler</span>
          <span className="cdash-section-count">{offers.length}</span>
        </h2>
        <div className="tabstrip" role="tablist" aria-label="Teklif görünümü">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'list'}
            className={`cdash-tab${mode === 'list' ? ' is-active' : ''}`}
            onClick={() => setMode('list')}
          >
            <IconClipList size={14} />
            Liste
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'compare'}
            className={`cdash-tab${mode === 'compare' ? ' is-active' : ''}`}
            onClick={() => setMode('compare')}
          >
            <IconCompare size={14} />
            Karşılaştırma tablosu
          </button>
        </div>
      </div>

      {mode === 'list' ? (
        <div>
          {offers.map((offer) => (
            <OfferRow key={offer.id} offer={offer} requestId={requestId} isLowest={offer.id === lowestId} />
          ))}
        </div>
      ) : (
        <CompareTable offers={offers} requestId={requestId} lowestId={lowestId} />
      )}
    </>
  );
}

function OfferRow({
  offer,
  requestId,
  isLowest,
}: {
  offer: RequestOfferPreview;
  requestId: string;
  isLowest: boolean;
}) {
  const initials = getInitials(offer.provider.businessName);
  const offerReference = offer.offerNumber ?? `#${offer.id.slice(-6).toUpperCase()}`;

  return (
    <article className="cdash-offer">
      <div className="cdash-offer-head">
        <div className="cdash-offer-provider">
          <span className="cdash-offer-avatar" aria-hidden="true">
            {initials}
          </span>
          <div style={{ minWidth: 0 }}>
            <h3 className="cdash-offer-name">{offer.provider.businessName}</h3>
            <p className="cdash-offer-sub">
              {offer.provider.city}
              {offer.provider.district ? `, ${offer.provider.district}` : ''} ·{' '}
              {formatDateTime(offer.submittedAt)} · {offerReference}
            </p>
          </div>
          <span className={offerStatusClass(offer.status)}>{offerStatusLabel(offer.status)}</span>
        </div>

        {offer.message ? <p className="cdash-offer-message">{offer.message}</p> : null}

        <div className="cdash-offer-tags">
          {isLowest ? <span className="tag tag-accent">En düşük tutar</span> : null}
          {offer.warrantyNote ? <span className="tag tag-neutral">Garanti notu var</span> : null}
          {offer.estimatedCompletionDate ? (
            <span className="tag tag-neutral">
              Tahmini bitiş: {formatDate(offer.estimatedCompletionDate)}
            </span>
          ) : null}
        </div>

        {offer.warrantyNote ? (
          <p className="cdash-offer-warranty">Garanti notu: {offer.warrantyNote}</p>
        ) : null}
      </div>

      <div className="cdash-offer-side">
        <span className="cdash-offer-price-label">Teklif tutarı</span>
        <span className="cdash-offer-price">{formatPrice(offer.priceAmount, offer.currency)}</span>
        <div className="cdash-offer-actions">
          <Link
            className="cdash-btn cdash-btn-primary cdash-btn-block"
            href={`/requests/${requestId}/offers/${offer.id}`}
          >
            Teklifi İncele
            <IconArrowRight size={12} />
          </Link>
        </div>
      </div>
    </article>
  );
}

const COMPARE_ROWS: ReadonlyArray<{
  label: string;
  render: (offer: RequestOfferPreview) => string;
}> = [
  {
    label: 'Teklif tutarı',
    render: (offer) => formatPrice(offer.priceAmount, offer.currency),
  },
  {
    label: 'Garanti',
    render: (offer) => offer.warrantyNote ?? 'Belirtilmedi',
  },
  {
    label: 'En erken başlangıç',
    render: (offer) => (offer.estimatedStartDate ? formatDate(offer.estimatedStartDate) : 'Belirtilmedi'),
  },
  {
    label: 'Tahmini bitiş',
    render: (offer) =>
      offer.estimatedCompletionDate ? formatDate(offer.estimatedCompletionDate) : 'Belirtilmedi',
  },
  {
    label: 'Teklif tarihi',
    render: (offer) => formatDateTime(offer.submittedAt),
  },
  {
    label: 'Durum',
    render: (offer) => offerStatusLabel(offer.status),
  },
];

/**
 * The same offers, side by side.
 *
 * Only the fields the offer actually carries appear as rows: no experience,
 * rating or "materials included" column, because no offer records those. The
 * highlighted column is the cheapest one — a fact, not a recommendation.
 */
function CompareTable({
  offers,
  requestId,
  lowestId,
}: {
  offers: RequestOfferPreview[];
  requestId: string;
  lowestId: string | null;
}) {
  return (
    <>
      <div className="compare-panel">
        <div className="tablewrap">
          <table className="compare-table">
            <caption className="visually-hidden">Gelen tekliflerin karşılaştırması</caption>
            <thead>
              <tr>
                <th scope="col" className="compare-row-label">
                  Kriter
                </th>
                {offers.map((offer) => (
                  <th
                    scope="col"
                    key={offer.id}
                    className={offer.id === lowestId ? 'compare-col-recommended' : undefined}
                  >
                    <span className="compare-head-name">{offer.provider.businessName}</span>
                    <span className="compare-head-meta">
                      {offer.provider.city}
                      {offer.provider.district ? `, ${offer.provider.district}` : ''}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARE_ROWS.map((row) => (
                <tr key={row.label}>
                  <th scope="row" className="compare-row-label">
                    {row.label}
                  </th>
                  {offers.map((offer) => (
                    <td
                      key={offer.id}
                      className={offer.id === lowestId ? 'compare-col-recommended' : undefined}
                    >
                      {row.render(offer)}
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <th scope="row" className="compare-row-label">
                  Karar
                </th>
                {offers.map((offer) => (
                  <td
                    key={offer.id}
                    className={offer.id === lowestId ? 'compare-col-recommended' : undefined}
                  >
                    {/*
                      Kabul etme adımı teklif detayında kalır: geri alınamaz bir
                      karar, sonuçlarının yazılı olduğu ekranda onaylanır.
                    */}
                    <Link
                      className={
                        offer.id === lowestId
                          ? 'cdash-btn cdash-btn-primary cdash-btn-sm'
                          : 'cdash-btn cdash-btn-secondary cdash-btn-sm'
                      }
                      href={`/requests/${requestId}/offers/${offer.id}`}
                    >
                      Teklifi İncele
                    </Link>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="compare-notes">
        <div className="compare-note-cell">
          <span className="compare-note-title">Kabul edince ne olur?</span>
          Talep eşleşir, diğer teklifler kapanır ve yeni teklif alınmaz.
        </div>
        <div className="compare-note-cell">
          <span className="compare-note-title">Fiyat tek kriter değil</span>
          Garanti, başlangıç zamanı ve teklif mesajını birlikte değerlendirin.
        </div>
        <div className="compare-note-cell">
          <span className="compare-note-title">Ödeme TakTick üzerinden değil</span>
          Ücret, anlaştığınız hizmet verenle doğrudan görüşülür.
        </div>
      </div>
    </>
  );
}

const OFFER_STATUS_LABELS: Record<OfferStatus, string> = {
  SUBMITTED: 'Bekliyor',
  VIEWED: 'Görüntülendi',
  SHORTLISTED: 'Kısa listede',
  ACCEPTED: 'Kabul edildi',
  REJECTED: 'Reddedildi',
  WITHDRAWN: 'Geri çekildi',
  EXPIRED: 'Süresi doldu',
  CANCELLED: 'İptal edildi',
};

function offerStatusLabel(status: OfferStatus): string {
  return OFFER_STATUS_LABELS[status] ?? statusLabel(status);
}

function offerStatusClass(status: OfferStatus): string {
  switch (status) {
    case 'ACCEPTED':
      return 'tag tag-ink';
    case 'REJECTED':
    case 'WITHDRAWN':
    case 'EXPIRED':
    case 'CANCELLED':
      return 'tag tag-neutral';
    case 'SHORTLISTED':
      return 'tag tag-accent';
    case 'SUBMITTED':
    case 'VIEWED':
    default:
      return 'tag tag-neutral';
  }
}

function getInitials(value: string): string {
  const cleaned = value.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  if (!cleaned) return 'H';
  const parts = cleaned.split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toLocaleUpperCase('tr-TR')).join('') || 'H';
}
