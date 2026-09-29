import Link from 'next/link';
import { pageHref, type QueryParams } from '../lib/list-query';
import { cursorSummary, formatCount, pageSummary, pageWindow } from '../lib/pagination';

type PagerLinkProps = { href: string | null; rel: 'prev' | 'next'; label: string; testId?: string };

/**
 * Önceki / Sonraki. A page that does not exist is not a link: it stays in
 * place, visibly disabled and `aria-disabled`, so the bar does not jump and a
 * screen reader hears that the direction is there but closed.
 */
function PagerLink({ href, rel, label, testId }: PagerLinkProps) {
  const className = rel === 'next' ? 'btn btn-secondary btn-sm is-next' : 'btn btn-secondary btn-sm';
  return href ? (
    <Link className={className} href={href} rel={rel} data-testid={testId}>
      {label}
    </Link>
  ) : (
    <span className={`${className} is-disabled`} aria-disabled="true" data-testid={testId}>
      {label}
    </span>
  );
}

/**
 * The list footer for a page-based list: "148 kaydın 51–100 arası
 * gösteriliyor" and Önceki / Sonraki as links that keep every filter.
 */
export function Pagination({
  path,
  params,
  page,
  pageSize,
  total,
  hasNextPage,
  noun,
  summaryTestId,
}: {
  path: string;
  params: QueryParams;
  page: number;
  pageSize: number;
  total: number;
  hasNextPage?: boolean;
  noun?: string;
  summaryTestId?: string;
}) {
  const current = pageWindow({ page, pageSize, total, hasNextPage });
  return (
    <nav className="pagination" aria-label="Sayfalama">
      <p className="pagination-summary" data-testid={summaryTestId}>
        {pageSummary(current, noun)}
      </p>
      <div className="pagination-links">
        <PagerLink
          rel="prev"
          label="Önceki"
          href={current.hasPrevious ? pageHref(path, params, current.page - 1) : null}
          testId="pagination-previous"
        />
        <PagerLink
          rel="next"
          label="Sonraki"
          href={current.hasNext ? pageHref(path, params, current.page + 1) : null}
          testId="pagination-next"
        />
      </div>
    </nav>
  );
}

/**
 * The same footer for a cursor-based list, which knows its neighbours but not
 * its total — so it says how many rows are on this page and nothing more.
 */
export function CursorPagination({
  count,
  previousHref,
  nextHref,
  noun,
  summaryTestId,
}: {
  count: number;
  previousHref: string | null;
  nextHref: string | null;
  noun?: string;
  summaryTestId?: string;
}) {
  return (
    <nav className="pagination" aria-label="Sayfalama">
      <p className="pagination-summary" data-testid={summaryTestId}>
        {cursorSummary(count, noun)}
      </p>
      <div className="pagination-links">
        <PagerLink rel="prev" label="Önceki" href={previousHref} testId="pagination-previous" />
        <PagerLink rel="next" label="Sonraki" href={nextHref} testId="pagination-next" />
      </div>
    </nav>
  );
}

/**
 * The footer for a list the API returns whole — no page, no cursor — so the
 * count is the list's real size and there is nowhere to go next. When the API
 * stops at a fixed number of rows (`cap`) and this answer reached it, the
 * footer says the list is the newest `cap` rather than claiming it is all.
 * Önceki / Sonraki are not drawn: a pager with nothing behind it would promise
 * pages that do not exist.
 */
export function WholeListFooter({
  count,
  noun = 'kayıt',
  cap,
  summaryTestId,
}: {
  count: number;
  noun?: string;
  cap?: number;
  summaryTestId?: string;
}) {
  const capped = cap !== undefined && count >= cap;
  return (
    <nav className="pagination" aria-label="Liste sonu">
      <p className="pagination-summary" data-testid={summaryTestId} data-capped={capped || undefined}>
        {capped
          ? `En yeni ${formatCount(cap)} ${noun} gösteriliyor · daha eskileri bu ekranda listelenmez`
          : `${formatCount(count)} ${noun}, tamamı gösteriliyor`}
      </p>
    </nav>
  );
}
