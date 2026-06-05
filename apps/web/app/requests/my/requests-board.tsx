'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { CustomerServiceRequest } from '../../../lib/api';
import { formatDateTime, statusLabel } from '../../../lib/request-formatters';

type RequestsBoardProps = {
  requests: CustomerServiceRequest[];
};

const TABS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'all', label: 'Tümü' },
  { key: 'pending', label: 'Bekleyenler' },
  { key: 'approved', label: 'Onaylananlar' },
  { key: 'completed', label: 'Tamamlananlar' },
];

export function RequestsBoard({ requests }: RequestsBoardProps) {
  const [query, setQuery] = useState('');

  const normalizedQuery = query.trim().toLocaleLowerCase('tr-TR');

  const filtered = useMemo(() => {
    if (!normalizedQuery) return requests;
    return requests.filter((request) => {
      const haystack = [
        request.category?.name ?? '',
        request.city ?? '',
        request.district ?? '',
        request.requestNumber ?? '',
        statusLabel(request.status),
      ]
        .join(' ')
        .toLocaleLowerCase('tr-TR');
      return haystack.includes(normalizedQuery);
    });
  }, [requests, normalizedQuery]);

  const totalCount = requests.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="cdash-filters">
        <div className="cdash-tabs" role="tablist" aria-label="Talep durumu (yakında)">
          {TABS.map((tab, idx) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={idx === 0}
              aria-disabled="true"
              className={`cdash-tab${idx === 0 ? ' is-active' : ''}`}
              title={idx === 0 ? undefined : 'Yakında'}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="cdash-search">
          <span aria-hidden="true">🔍</span>
          <input
            type="search"
            placeholder="Talep ara..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Talep ara"
          />
        </div>
      </div>

      {totalCount === 0 ? (
        <div className="cdash-empty">
          <h3>Henüz talep oluşturmadınız</h3>
          <p>Bir kategori seçerek ilk talebinizi oluşturabilirsiniz.</p>
          <Link className="cdash-btn cdash-btn-primary" href="/categories">
            Hizmet kategorilerine git
          </Link>
        </div>
      ) : filtered.length === 0 ? (
        <div className="cdash-empty">
          <h3>Sonuç bulunamadı</h3>
          <p>
            "{query}" için eşleşen talep yok. Aramayı temizleyerek tüm taleplerinizi görüntüleyebilirsiniz.
          </p>
          <button
            type="button"
            className="cdash-btn cdash-btn-secondary"
            onClick={() => setQuery('')}
          >
            Aramayı temizle
          </button>
        </div>
      ) : (
        <div className="cdash-grid">
          {filtered.map((request) => (
            <RequestCard key={request.id} request={request} />
          ))}
        </div>
      )}
    </div>
  );
}

function RequestCard({ request }: { request: CustomerServiceRequest }) {
  const hasOffers = request.offersCount > 0;
  const offersText = hasOffers ? `${request.offersCount} teklif geldi` : 'Henüz teklif yok';
  const offersBadgeClass = `cdash-badge ${hasOffers ? 'cdash-badge-info' : 'cdash-badge-muted'}`;
  const ctaLabel = hasOffers ? 'Teklifleri görüntüle' : 'Detaylar';
  const ctaClass = hasOffers ? 'cdash-btn cdash-btn-primary' : 'cdash-btn cdash-btn-secondary';
  const statusClass = statusBadgeClass(request.status);
  const referenceLabel =
    request.requestNumber ?? `#${request.id.slice(-6).toUpperCase()}`;

  return (
    <article className="cdash-card">
      <div className="cdash-card-head">
        <div style={{ minWidth: 0 }}>
          <h2 className="cdash-card-title">{request.category?.name ?? 'Talep'}</h2>
          <p className="cdash-card-sub">{referenceLabel}</p>
        </div>
        <span className={statusClass}>{statusLabel(request.status)}</span>
      </div>

      <div className="cdash-card-meta">
        <span>
          <span aria-hidden="true">📅</span>
          {formatDateTime(request.submittedAt)}
        </span>
        <span>
          <span aria-hidden="true">📍</span>
          {request.city}
          {request.district ? `, ${request.district}` : ''}
        </span>
      </div>

      <div className="cdash-card-foot">
        <span className={offersBadgeClass}>{offersText}</span>
        <Link className={ctaClass} href={`/requests/${request.id}/offers`}>
          {ctaLabel}
        </Link>
      </div>
    </article>
  );
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'APPROVED':
    case 'ACCEPTED':
      return 'cdash-badge cdash-badge-success';
    case 'SUBMITTED':
    case 'IN_REVIEW':
    case 'PENDING':
    case 'PENDING_REVIEW':
      return 'cdash-badge cdash-badge-warn';
    case 'REJECTED':
    case 'CANCELLED':
    case 'EXPIRED':
      return 'cdash-badge cdash-badge-danger';
    default:
      return 'cdash-badge cdash-badge-muted';
  }
}
