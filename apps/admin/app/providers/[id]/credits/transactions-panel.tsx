'use client';

import { formatDateTime } from '@taktic/shared';
import { useMemo, useState } from 'react';

type CreditTransactionType =
  | 'ADMIN_GRANT'
  | 'ADMIN_DEDUCT'
  | 'PACKAGE_PURCHASE'
  | 'OFFER_SPEND'
  | 'OFFER_REFUND'
  | 'ADJUSTMENT';

type CreditTransaction = {
  id: string;
  providerId: string;
  type: CreditTransactionType;
  amount: number;
  balanceAfter: number;
  reason: string | null;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
  createdBy?: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
};

type TransactionsPanelProps = {
  transactions: CreditTransaction[];
};

type FilterValue = 'ALL' | 'ADMIN' | 'PACKAGE' | 'OFFER' | 'REFUND';

const TYPE_LABELS: Record<CreditTransactionType, string> = {
  ADMIN_GRANT: 'Yönetici eklemesi',
  ADMIN_DEDUCT: 'Yönetici düşümü',
  PACKAGE_PURCHASE: 'Paket alımı',
  OFFER_SPEND: 'Teklif harcaması',
  OFFER_REFUND: 'Teklif iadesi',
  ADJUSTMENT: 'Düzeltme',
};

const TYPE_BADGE_CLASS: Record<CreditTransactionType, string> = {
  ADMIN_GRANT: 'transaction-type-badge tone-grant',
  ADMIN_DEDUCT: 'transaction-type-badge tone-deduct',
  PACKAGE_PURCHASE: 'transaction-type-badge tone-package',
  OFFER_SPEND: 'transaction-type-badge tone-spend',
  OFFER_REFUND: 'transaction-type-badge tone-refund',
  ADJUSTMENT: 'transaction-type-badge tone-adjustment',
};

const FILTERS: { value: FilterValue; label: string; matches: (t: CreditTransaction) => boolean }[] = [
  { value: 'ALL', label: 'Tümü', matches: () => true },
  {
    value: 'ADMIN',
    label: 'Yönetici',
    matches: (t) => t.type === 'ADMIN_GRANT' || t.type === 'ADMIN_DEDUCT',
  },
  { value: 'PACKAGE', label: 'Paket', matches: (t) => t.type === 'PACKAGE_PURCHASE' },
  { value: 'OFFER', label: 'Teklif', matches: (t) => t.type === 'OFFER_SPEND' },
  { value: 'REFUND', label: 'İade', matches: (t) => t.type === 'OFFER_REFUND' },
];

// Pinned zone and locale, from the one shared implementation. This file used
// to carry its own correct copy of the rules, which is how the other copies
// drifted out of agreement with it.

function typeLabel(type: CreditTransactionType) {
  return TYPE_LABELS[type] ?? type;
}

function typeBadgeClass(type: CreditTransactionType) {
  return TYPE_BADGE_CLASS[type] ?? 'transaction-type-badge';
}

function formatAmount(amount: number) {
  if (amount > 0) return `+${amount}`;
  return `${amount}`;
}

const SOURCE_LABELS: Partial<Record<CreditTransactionType, string>> = {
  ADMIN_GRANT: 'Manuel işlem',
  ADMIN_DEDUCT: 'Manuel işlem',
  PACKAGE_PURCHASE: 'Paket alımı',
  OFFER_SPEND: 'Teklif harcaması',
  OFFER_REFUND: 'Teklif iadesi',
  ADJUSTMENT: 'Düzeltme',
};

type SourceInfo = {
  label: string;
  referenceId: string | null;
};

function sourceInfo(transaction: CreditTransaction): SourceInfo | null {
  const baseLabel = SOURCE_LABELS[transaction.type];

  if (transaction.type === 'ADMIN_GRANT' || transaction.type === 'ADMIN_DEDUCT') {
    return { label: baseLabel ?? 'Manuel işlem', referenceId: null };
  }

  if (!baseLabel && !transaction.referenceType && !transaction.referenceId) {
    return null;
  }

  return {
    label: baseLabel ?? transaction.referenceType ?? 'Referans',
    referenceId: transaction.referenceId ?? null,
  };
}

export function TransactionsPanel({ transactions }: TransactionsPanelProps) {
  const [filter, setFilter] = useState<FilterValue>('ALL');
  const [query, setQuery] = useState('');

  const filteredTransactions = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('tr-TR');
    const activeFilter = FILTERS.find((entry) => entry.value === filter);
    const matches = activeFilter?.matches ?? (() => true);

    return transactions.filter((transaction) => {
      if (!matches(transaction)) return false;
      if (!q) return true;

      const haystack = [
        transaction.reason,
        transaction.createdBy?.name,
        transaction.createdBy?.email,
        transaction.referenceType,
        transaction.referenceId,
        typeLabel(transaction.type),
      ]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase('tr-TR');

      return haystack.includes(q);
    });
  }, [transactions, filter, query]);

  return (
    <div className="transactions-panel">
      <div className="transaction-toolbar">
        <div className="transaction-toolbar-filters" role="tablist" aria-label="İşlem filtresi">
          {FILTERS.map((entry) => {
            const count = transactions.filter(entry.matches).length;
            const active = entry.value === filter;
            return (
              <button
                key={entry.value}
                type="button"
                role="tab"
                aria-selected={active}
                className={`transaction-filter-chip${active ? ' is-active' : ''}`}
                onClick={() => setFilter(entry.value)}
              >
                <span>{entry.label}</span>
                <span className="transaction-filter-chip-count">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="transaction-toolbar-search">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Sebep, yönetici veya referans ara"
            aria-label="İşlem ara"
          />
        </div>
      </div>

      {filteredTransactions.length === 0 ? (
        <div className="empty-state">
          {transactions.length === 0
            ? 'Henüz kredi işlemi yok.'
            : 'Filtreyle eşleşen işlem bulunamadı.'}
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table transaction-table">
            <thead>
              <tr>
                <th>Tarih</th>
                <th>Tip</th>
                <th className="col-num">Tutar</th>
                <th className="col-num">Önceki</th>
                <th className="col-num">Sonraki</th>
                <th>Sebep</th>
                <th>Yapan</th>
                <th>Kaynak</th>
              </tr>
            </thead>
            <tbody>
              {filteredTransactions.map((transaction) => {
                const previousBalance = transaction.balanceAfter - transaction.amount;
                const source = sourceInfo(transaction);
                const isPositive = transaction.amount >= 0;
                const isManualType =
                  transaction.type === 'ADMIN_GRANT' || transaction.type === 'ADMIN_DEDUCT';
                return (
                  <tr key={transaction.id}>
                    <td>{formatDateTime(transaction.createdAt)}</td>
                    <td>
                      <span className={typeBadgeClass(transaction.type)}>
                        {typeLabel(transaction.type)}
                      </span>
                    </td>
                    <td className="col-num">
                      <span
                        className={`transaction-amount${
                          isPositive ? ' is-positive' : ' is-negative'
                        }`}
                      >
                        {formatAmount(transaction.amount)}
                      </span>
                    </td>
                    <td className="col-num">{previousBalance}</td>
                    <td className="col-num">
                      <strong>{transaction.balanceAfter}</strong>
                    </td>
                    <td>
                      {transaction.reason ? (
                        transaction.reason
                      ) : (
                        <span className="cell-muted">—</span>
                      )}
                    </td>
                    <td>
                      {transaction.createdBy ? (
                        <div className="cell-stack">
                          <span>
                            {transaction.createdBy.name ?? transaction.createdBy.email ?? 'Yönetici'}
                          </span>
                          {transaction.createdBy.name && transaction.createdBy.email ? (
                            <span className="cell-muted">{transaction.createdBy.email}</span>
                          ) : null}
                        </div>
                      ) : isManualType ? (
                        <div className="cell-stack">
                          <span className="cell-muted">Bilinmeyen yönetici</span>
                          <span className="cell-muted" style={{ fontSize: 11 }}>
                            (eski kayıt)
                          </span>
                        </div>
                      ) : (
                        <span className="cell-muted">Sistem</span>
                      )}
                    </td>
                    <td>
                      {source ? (
                        <div className="cell-stack">
                          <span>{source.label}</span>
                          {source.referenceId ? (
                            <code className="cell-muted transaction-reference-id">
                              {source.referenceId}
                            </code>
                          ) : null}
                        </div>
                      ) : (
                        <span className="cell-muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
