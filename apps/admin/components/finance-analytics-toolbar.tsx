'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FinanceAnalyticsGroupBy } from '../lib/api';

export type AnalyticsPeriod = '7d' | '30d' | 'this_month' | 'this_year' | 'custom';

type PeriodOption = { value: AnalyticsPeriod; label: string };

const PERIOD_OPTIONS: PeriodOption[] = [
  { value: '7d', label: 'Son 7 gün' },
  { value: '30d', label: 'Son 30 gün' },
  { value: 'this_month', label: 'Bu ay' },
  { value: 'this_year', label: 'Bu yıl' },
  { value: 'custom', label: 'Özel aralık' },
];

const GROUP_BY_OPTIONS: { value: FinanceAnalyticsGroupBy; label: string }[] = [
  { value: 'day', label: 'Günlük' },
  { value: 'month', label: 'Aylık' },
  { value: 'year', label: 'Yıllık' },
];

type FinanceAnalyticsToolbarProps = {
  initialPeriod: AnalyticsPeriod;
  initialFrom: string;
  initialTo: string;
  initialGroupBy: FinanceAnalyticsGroupBy;
  summary: string;
};

export function FinanceAnalyticsToolbar({
  initialPeriod,
  initialFrom,
  initialTo,
  initialGroupBy,
  summary,
}: FinanceAnalyticsToolbarProps) {
  const [period, setPeriod] = useState<AnalyticsPeriod>(initialPeriod);
  const isCustom = period === 'custom';

  return (
    <form className="admin-toolbar" method="get" action="/finance">
      <div className="admin-toolbar-field">
        <label htmlFor="finance-period">Dönem</label>
        <select
          id="finance-period"
          name="period"
          value={period}
          onChange={(e) => setPeriod(e.target.value as AnalyticsPeriod)}
        >
          {PERIOD_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="admin-toolbar-field">
        <label htmlFor="finance-from">Başlangıç</label>
        <input
          id="finance-from"
          name="from"
          type="date"
          defaultValue={initialFrom}
          disabled={!isCustom}
          autoComplete="off"
        />
      </div>
      <div className="admin-toolbar-field">
        <label htmlFor="finance-to">Bitiş</label>
        <input
          id="finance-to"
          name="to"
          type="date"
          defaultValue={initialTo}
          disabled={!isCustom}
          autoComplete="off"
        />
      </div>
      <div className="admin-toolbar-field">
        <label htmlFor="finance-groupby">Gruplama</label>
        <select
          id="finance-groupby"
          name="groupBy"
          defaultValue={initialGroupBy}
          disabled={!isCustom}
        >
          {GROUP_BY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="admin-toolbar-actions">
        <span className="admin-toolbar-summary">{summary}</span>
        <button className="btn btn-secondary btn-sm" type="submit">
          Uygula
        </button>
        <Link className="btn btn-ghost btn-sm" href="/finance">
          Temizle
        </Link>
      </div>
    </form>
  );
}
