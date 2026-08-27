'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
// Types only: `lib/api` reaches for next/headers and cannot be bundled here.
import type { ProviderOffer } from '../../../../lib/api';
import { formatDateTime, formatPrice, refundActionLabel } from '../../../../lib/formatters';
import {
  canOpenRequestDetail,
  canWithdrawOffer,
  providerOfferStatusLabel,
  providerRefundBadgeClass,
  providerStatusBadgeClass,
} from '../../provider-ui';

type OffersTableProps = {
  providerId: string;
  offers: ProviderOffer[];
};

/**
 * The provider's offers, filtered by real status groups.
 *
 * A rejected offer is always described the same way — see
 * providerOfferStatusLabel — so no tab here tells a provider that a competitor
 * won, or how many rivals a request had.
 */
const TABS: ReadonlyArray<{ key: string; label: string; match: (offer: ProviderOffer) => boolean }> = [
  { key: 'all', label: 'Tümü', match: () => true },
  {
    key: 'pending',
    label: 'Bekleyen',
    match: (offer) =>
      offer.status === 'SUBMITTED' || offer.status === 'VIEWED' || offer.status === 'SHORTLISTED',
  },
  { key: 'won', label: 'Kazanılan', match: (offer) => offer.status === 'ACCEPTED' },
  {
    key: 'closed',
    label: 'Sonuçlanan',
    match: (offer) =>
      offer.status === 'REJECTED' ||
      offer.status === 'WITHDRAWN' ||
      offer.status === 'EXPIRED' ||
      offer.status === 'CANCELLED',
  },
  { key: 'refunded', label: 'İade', match: (offer) => offer.creditRefundedAt !== null },
];

export function OffersTable({ providerId, offers }: OffersTableProps) {
  const [tab, setTab] = useState('all');
  const activeTab = TABS.find((entry) => entry.key === tab) ?? TABS[0]!;

  const filtered = useMemo(() => offers.filter(activeTab.match), [offers, activeTab]);

  return (
    <>
      <div className="tabstrip-wrap">
        <div className="tabstrip" role="tablist" aria-label="Teklif durumu">
          {TABS.map((entry) => {
            const isActive = entry.key === tab;
            return (
              <button
                key={entry.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`cdash-tab${isActive ? ' is-active' : ''}`}
                onClick={() => setTab(entry.key)}
              >
                {entry.label}
              </button>
            );
          })}
        </div>
        <span className="tabstrip-count" aria-live="polite">
          {filtered.length} teklif gösteriliyor
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="pdash-empty" style={{ marginTop: 24 }}>
          <h3>Bu filtrede teklif yok</h3>
          <p>Farklı bir durum sekmesi seçerek tüm tekliflerinizi görebilirsiniz.</p>
          <button type="button" className="pdash-btn pdash-btn-secondary" onClick={() => setTab('all')}>
            Tümünü göster
          </button>
        </div>
      ) : (
        <div className="tablewrap" style={{ marginTop: 16 }}>
          <table className="pdash-table" style={{ minWidth: 800 }}>
            <thead>
              <tr>
                <th>Talep</th>
                <th>Referans</th>
                <th>Tutar</th>
                <th>Durum</th>
                <th>Kredi</th>
                <th>İade politikası</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((offer) => (
                <tr key={offer.id}>
                  <td>
                    <strong>{offer.request.category.name}</strong>
                    <div className="pdash-card-sub">
                      {offer.request.city}/{offer.request.district} ·{' '}
                      {formatDateTime(offer.submittedAt)}
                    </div>
                  </td>
                  <td>
                    <span className="pdash-card-sub">
                      {offer.offerNumber ?? `#${offer.id.slice(-6).toUpperCase()}`}
                    </span>
                  </td>
                  <td>{formatPrice(offer.priceAmount, offer.currency)}</td>
                  <td>
                    <span className={providerStatusBadgeClass(offer.status)}>
                      {providerOfferStatusLabel(offer.status)}
                    </span>
                  </td>
                  <td>
                    −{offer.creditCost}
                    {offer.creditRefundedAt ? (
                      <div className="pdash-card-sub">
                        +{offer.creditCost} iade · {formatDateTime(offer.creditRefundedAt)}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <span
                      className={providerRefundBadgeClass(offer.refundEligibility.recommendedAction)}
                    >
                      {refundActionLabel(offer.refundEligibility.recommendedAction)}
                    </span>
                  </td>
                  <td>
                    <div className="pdash-actions">
                      {/*
                        A link, not the action itself: withdrawing is irreversible
                        and unrefunded, so it is only ever confirmed on the detail
                        screen where those consequences are spelled out.
                      */}
                      {canWithdrawOffer(offer.status, offer.request.status) ? (
                        <Link
                          className="pdash-btn pdash-btn-ghost pdash-btn-sm"
                          href={`/providers/${providerId}/offers/${offer.id}#geri-cek`}
                        >
                          Geri çek
                        </Link>
                      ) : null}
                      {/*
                        Only while the request is still open: the provider
                        panel's request screen is the discovery screen, and
                        discovery answers 404 for a request that has matched,
                        completed, expired or been cancelled.
                      */}
                      {canOpenRequestDetail(offer.request.status) ? (
                        <Link
                          className="pdash-btn pdash-btn-secondary pdash-btn-sm"
                          href={`/providers/${providerId}/requests/${offer.request.id}`}
                          data-testid="offer-row-request-link"
                        >
                          Talep
                        </Link>
                      ) : null}
                      <Link
                        className="pdash-btn pdash-btn-primary pdash-btn-sm"
                        href={`/providers/${providerId}/offers/${offer.id}`}
                      >
                        Teklif Detayı
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
