'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { CustomerServiceRequest } from '../../../lib/api';
import { CategoryVisual } from '../../category-visual';
import { IconArrowRight, IconSearch } from '../../landing-icons';
import { formatDateTime, statusLabel } from '../../../lib/request-formatters';
import { statusPillClass } from '../../status-pill';

type RequestsBoardProps = {
  requests: CustomerServiceRequest[];
};

/** The status groups the board filters by, matched against the API's own enum. */
const TABS: ReadonlyArray<{ key: string; label: string; match: (status: string) => boolean }> = [
  { key: 'all', label: 'Tümü', match: () => true },
  { key: 'live', label: 'Yayında', match: (s) => s === 'APPROVED' },
  {
    key: 'review',
    label: 'İncelemede',
    match: (s) => s === 'SUBMITTED' || s === 'IN_REVIEW' || s === 'PENDING_REVIEW',
  },
  { key: 'matched', label: 'Eşleşen', match: (s) => s === 'MATCHED' },
  { key: 'done', label: 'Tamamlanan', match: (s) => s === 'COMPLETED' },
];

export function RequestsBoard({ requests }: RequestsBoardProps) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('all');

  const normalizedQuery = query.trim().toLocaleLowerCase('tr-TR');
  const activeTab = TABS.find((entry) => entry.key === tab) ?? TABS[0]!;

  const filtered = useMemo(() => {
    return requests.filter((request) => {
      if (!activeTab.match(request.status)) return false;
      if (!normalizedQuery) return true;

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
  }, [requests, normalizedQuery, activeTab]);

  const totalCount = requests.length;

  return (
    <div>
      <div className="tabstrip-wrap">
        <div className="tabstrip" role="tablist" aria-label="Talep durumu">
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

        <div className="cdash-search">
          <IconSearch size={14} />
          <input
            type="search"
            placeholder="Talep ara..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Talep ara"
          />
        </div>
      </div>

      <p className="tabstrip-count" style={{ margin: '12px 0 0' }} aria-live="polite">
        {filtered.length} talep gösteriliyor
      </p>

      {totalCount === 0 ? (
        <div className="cdash-empty" style={{ marginTop: 24 }}>
          <h3>Henüz talep oluşturmadınız</h3>
          <p>Bir kategori seçerek ilk talebinizi oluşturabilirsiniz.</p>
          <Link className="cdash-btn cdash-btn-primary" href="/categories">
            Hizmet kategorilerine git
          </Link>
        </div>
      ) : filtered.length === 0 ? (
        <div className="cdash-empty" style={{ marginTop: 24 }}>
          <h3>Sonuç bulunamadı</h3>
          <p>
            Seçtiğiniz filtreyle eşleşen talep yok. Filtreyi veya aramayı temizleyerek tüm
            taleplerinizi görüntüleyebilirsiniz.
          </p>
          <button
            type="button"
            className="cdash-btn cdash-btn-secondary"
            onClick={() => {
              setQuery('');
              setTab('all');
            }}
          >
            Filtreyi temizle
          </button>
        </div>
      ) : (
        <div className="rowlist" style={{ marginTop: 16 }}>
          {filtered.map((request) => (
            <RequestRow key={request.id} request={request} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A neutral, factual line for a closed request: what happened and what it means
 * from here. No apology, no blame, and no promise that anything will change.
 */
function statusNote(request: CustomerServiceRequest): string | null {
  if (request.status !== 'EXPIRED') {
    return null;
  }

  return request.expiredAt
    ? `Talebin geçerlilik süresi ${formatDateTime(request.expiredAt)} tarihinde doldu. Yeni teklif alınmıyor.`
    : 'Talebin geçerlilik süresi doldu. Yeni teklif alınmıyor.';
}

function RequestRow({ request }: { request: CustomerServiceRequest }) {
  const hasOffers = request.offersCount > 0;
  const note = statusNote(request);
  const ctaLabel = hasOffers ? 'Teklifleri gör' : 'Detaylar';
  const ctaClass = hasOffers ? 'cdash-btn cdash-btn-primary' : 'cdash-btn cdash-btn-secondary';
  const referenceLabel = request.requestNumber ?? `#${request.id.slice(-6).toUpperCase()}`;

  return (
    <article className="datarow" data-testid="request-card" data-request-id={request.id}>
      <span className="datarow-media">
        <CategoryVisual
          slug={request.category?.slug}
          name={request.category?.name ?? 'Talep'}
          iconSize={26}
          alt=""
        />
      </span>

      <div className="datarow-body">
        <h2 className="datarow-title">
          <span>{request.category?.name ?? 'Talep'}</span>
          <span className={statusPillClass(request.status)} data-testid="request-status">
            {statusLabel(request.status)}
          </span>
        </h2>
        <p className="datarow-meta">
          <span>{referenceLabel}</span>
          <span>
            {request.city}
            {request.district ? `, ${request.district}` : ''}
          </span>
          <span>{formatDateTime(request.submittedAt)}</span>
        </p>
        {note ? <p className="cdash-card-note">{note}</p> : null}
      </div>

      <div className="datarow-stat">
        <span className="datarow-stat-label">Kalite</span>
        <span className="datarow-stat-value">{request.qualityScore}/100</span>
      </div>

      <div className="datarow-stat">
        <span className="datarow-stat-label">Teklif</span>
        <span className="datarow-stat-value" data-testid="request-offers-count">
          {request.offersCount}
        </span>
      </div>

      <div className="datarow-actions">
        <Link className={ctaClass} href={`/requests/${request.id}/offers`}>
          {ctaLabel}
          <IconArrowRight size={12} />
        </Link>
      </div>
    </article>
  );
}

