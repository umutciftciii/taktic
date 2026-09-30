import Link from 'next/link';
import { formatCount } from '../lib/pagination';
import { formatLedgerReason, formatSignedCount, type LedgerSource } from '../lib/finance-format';

/**
 * The cells every credit-ledger table shares — the finance summary's recent
 * movements, the ledger itself and the manual adjustments list (ADMIN-DESIGN-001
 * Faz 3D). They only draw what the row already says: the amount keeps its sign,
 * the balances are the API's own integers, and a related record is a link only
 * when the screen has already decided (`gateLedgerSource`) that this session
 * may open it.
 */

/** "+500" in green, "-10" in red, "0" plain — the row's own amount, never recomputed. */
export function SignedCredits({ amount }: { amount: number }) {
  const className = amount > 0 ? 'credit-delta is-in' : amount < 0 ? 'credit-delta is-out' : 'credit-delta';
  return <span className={className}>{formatSignedCount(amount)}</span>;
}

/** Before → after, as the ledger recorded them. */
export function BalanceChange({ before, after }: { before: number; after: number }) {
  return (
    <span className="balance-change">
      <span className="balance-change-before">{formatCount(before)}</span>
      <span aria-hidden="true"> → </span>
      <span className="sr-only"> sonra </span>
      <strong>{formatCount(after)}</strong>
    </span>
  );
}

export function LedgerReasonCell({ reason }: { reason: string | null }) {
  const formatted = formatLedgerReason(reason);
  if (!formatted) return <span className="cell-muted">—</span>;
  return (
    <div className="cell-stack">
      <span>{formatted.label}</span>
      {formatted.note ? <span className="cell-muted cell-break">Not: {formatted.note}</span> : null}
    </div>
  );
}

export function LedgerSourceCell({ source }: { source: LedgerSource }) {
  if (source.isSystem) return <span className="cell-muted">{source.label}</span>;
  const body = (
    <span className="cell-stack">
      <span>{source.label}</span>
      {source.displayNumber ? (
        <code className="cell-break">No: {source.displayNumber}</code>
      ) : source.shortId ? (
        <span className="cell-muted">Kısa ID: {source.shortId}</span>
      ) : null}
    </span>
  );
  return source.href ? <Link href={source.href}>{body}</Link> : body;
}

/** Who wrote the row: a named person, an address, or the system itself. */
export function LedgerActorCell({
  actor,
}: {
  actor: { id: string; name: string | null; email: string | null } | null | undefined;
}) {
  if (!actor) return <span className="cell-muted">Sistem</span>;
  return (
    <div className="cell-stack">
      <span className="cell-break">{actor.name ?? actor.email ?? actor.id}</span>
      {actor.email && actor.name ? <span className="cell-muted cell-break">{actor.email}</span> : null}
    </div>
  );
}

/** The business on a ledger row, with its contact line; a link only when `href` is given. */
export function LedgerProviderCell({
  provider,
  href,
}: {
  provider: { businessName: string; phone?: string | null; email?: string | null };
  href?: string | null;
}) {
  const name = <strong className="cell-break">{provider.businessName}</strong>;
  return (
    <div className="cell-stack">
      {href ? <Link href={href}>{name}</Link> : name}
      {provider.phone || provider.email ? (
        <span className="cell-muted cell-break">
          {provider.phone}
          {provider.phone && provider.email ? ' · ' : ''}
          {provider.email ?? ''}
        </span>
      ) : null}
    </div>
  );
}
