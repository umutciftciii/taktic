'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
// Types only: `lib/api` reaches for next/headers and cannot be bundled here.
import type { ProviderOffer } from '../../../../lib/api';
import { formatDateTime, formatPrice, refundSettlementSummary } from '../../../../lib/formatters';
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
        /*
          One table, two layouts, no horizontal scroll at either.

          From 1100px up it is a real table with fixed column widths, so the
          action column has the same width on every row whatever each row
          offers. Below that the CSS turns every row into a card: cells stack
          with their header as a label (`data-label`), and the actions become
          a full-width block. The markup is the same table in both — a screen
          reader still gets a table with headers.
        */
        <div className="offers-table-wrap" style={{ marginTop: 16 }} data-testid="offers-table-wrap">
          <table className="pdash-table offers-table" data-testid="offers-table">
            <thead>
              <tr>
                <th scope="col">Talep</th>
                <th scope="col">Referans</th>
                <th scope="col">Tutar</th>
                <th scope="col">Durum</th>
                <th scope="col">Kredi</th>
                <th scope="col">İade politikası</th>
                <th scope="col">
                  <span className="visually-hidden">İşlemler</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((offer) => {
                const showRequest = canOpenRequestDetail(offer.request.status);
                const showWithdraw = canWithdrawOffer(offer.status, offer.request.status);
                return (
                  <tr key={offer.id} data-testid="offer-row" data-offer-id={offer.id}>
                    <td data-label="Talep">
                      <strong>{offer.request.category.name}</strong>
                      <div className="pdash-card-sub">
                        {offer.request.city}/{offer.request.district} ·{' '}
                        {formatDateTime(offer.submittedAt)}
                      </div>
                    </td>
                    <td data-label="Referans">
                      <span className="pdash-card-sub">
                        {offer.offerNumber ?? `#${offer.id.slice(-6).toUpperCase()}`}
                      </span>
                    </td>
                    <td data-label="Tutar" className="offers-table-price">
                      {formatPrice(offer.priceAmount, offer.currency)}
                    </td>
                    <td data-label="Durum">
                      <span className={providerStatusBadgeClass(offer.status)}>
                        {providerOfferStatusLabel(offer.status)}
                      </span>
                    </td>
                    <td data-label="Kredi">
                      −{offer.creditCost}
                      {offer.creditRefundedAt ? (
                        <RefundLine offer={offer} />
                      ) : null}
                    </td>
                    <td data-label="İade politikası">
                      {/*
                        Nothing at all for an offer from before the policy: its
                        refund terms were different and it has no standing under
                        this one to report.
                      */}
                      {offer.refundEligibility.policyStatus ? (
                        <span
                          className={providerRefundBadgeClass(offer.refundEligibility.policyStatus)}
                        >
                          {offer.refundEligibility.policyStatusLabel}
                        </span>
                      ) : (
                        <span className="pdash-card-sub">-</span>
                      )}
                    </td>
                    <td className="offers-table-actions-cell">
                      {/*
                        Three fixed slots, so the primary action stands in the
                        same place on every row and a row with fewer secondary
                        actions leaves its slots empty rather than shifting the
                        others. Withdrawing is a link, not the action itself: it
                        is irreversible and unrefunded, so it is only confirmed
                        on the detail screen where those consequences are
                        spelled out. The request link shows only while the
                        request is still open — discovery answers 404 otherwise.
                      */}
                      <div className="offers-table-actions" data-testid="offer-row-actions">
                        <span className="offers-table-slot">
                          {showRequest ? (
                            <Link
                              className="pdash-btn pdash-btn-secondary pdash-btn-sm"
                              href={`/providers/${providerId}/requests/${offer.request.id}`}
                              data-testid="offer-row-request-link"
                            >
                              Talep
                            </Link>
                          ) : null}
                        </span>
                        <span className="offers-table-slot">
                          {showWithdraw ? (
                            <Link
                              className="pdash-btn pdash-btn-ghost pdash-btn-sm"
                              href={`/providers/${providerId}/offers/${offer.id}#geri-cek`}
                              data-testid="offer-row-withdraw-link"
                            >
                              Geri çek
                            </Link>
                          ) : null}
                        </span>
                        <span className="offers-table-slot offers-table-slot-primary">
                          <Link
                            className="pdash-btn pdash-btn-primary pdash-btn-sm"
                            href={`/providers/${providerId}/offers/${offer.id}`}
                            data-testid="offer-row-detail-link"
                          >
                            Teklif detayı
                          </Link>
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * The refund line under the credit cost (CMP-004 S4). Without a forfeited
 * promotion share it reads exactly as before; with one it states the gross,
 * the promotion taken back and the net, so the "+" is never more than the
 * balance actually gained.
 */
function RefundLine({ offer }: { offer: ProviderOffer }) {
  const summary = refundSettlementSummary(offer.creditRefundSettlement, offer.creditCost);
  return (
    <div className="pdash-card-sub" data-testid="offer-refund-line">
      {summary.headline} · {formatDateTime(offer.creditRefundedAt!)}
      {summary.detail ? <div className="pdash-card-sub">{summary.detail}</div> : null}
    </div>
  );
}
