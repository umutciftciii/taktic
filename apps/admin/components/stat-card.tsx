import Link from 'next/link';
import type { ReactNode } from 'react';

type StatTone = 'neutral' | 'success' | 'warning' | 'error';

type StatCardProps = {
  label: ReactNode;
  value: ReactNode;
  href?: string;
  tone?: StatTone;
  hint?: ReactNode;
};

const toneToBadge: Record<StatTone, string> = {
  neutral: 'badge',
  success: 'badge badge-good',
  warning: 'badge badge-warn',
  error: 'badge badge-bad',
};

const toneToLabel: Record<StatTone, string> = {
  neutral: '',
  success: 'iyi',
  warning: 'dikkat',
  error: 'uyarı',
};

export function StatCard({ label, value, href, tone = 'neutral', hint }: StatCardProps) {
  const inner = (
    <>
      <span className="stat-card-label">{label}</span>
      <span className="metric">{value}</span>
      {hint ? <span className="stat-card-hint">{hint}</span> : null}
      {tone !== 'neutral' ? <span className={toneToBadge[tone]}>{toneToLabel[tone]}</span> : null}
    </>
  );

  if (href) {
    return (
      <Link className="stat-card stat-card-link" href={href}>
        {inner}
      </Link>
    );
  }

  return <div className="stat-card">{inner}</div>;
}
