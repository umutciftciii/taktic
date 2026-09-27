import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatCount } from '../lib/pagination';
import { tabHref, type QueryParams } from '../lib/list-query';

export type TabItem = {
  /** The query value this tab writes; the default tab writes none. */
  key: string;
  label: ReactNode;
  /**
   * Shown beside the label only when the page already holds the number. A
   * count this screen would have to fetch separately is left out rather than
   * guessed — the design's counters are a promise about real data.
   */
  count?: number | null;
  testId?: string;
};

type TabsProps = {
  /** The navigation landmark's name, e.g. "Talep sekmeleri". */
  label: string;
  items: TabItem[];
  active: string;
  path: string;
  /** The rest of the current query (filters), carried into every tab link. */
  params?: QueryParams;
  /** Which query parameter the tabs write. `tab` for detail screens. */
  param?: string;
  /** The tab that is the plain URL. */
  defaultKey?: string;
  variant?: 'tabs' | 'views';
  testId?: string;
};

/**
 * Tabs as links.
 *
 * Each tab is an ordinary `<a>` to the same screen with a different query
 * value (`?tab=teklifler`), so a tab is shareable, survives a reload, works
 * with the browser's back button and needs no JavaScript. Because following
 * one navigates, they are marked up as navigation with `aria-current="page"` —
 * not as an ARIA `tablist`, which promises arrow-key switching in place.
 *
 * Moving between tabs drops the page number and keeps every other parameter.
 */
export function Tabs({
  label,
  items,
  active,
  path,
  params = {},
  param = 'tab',
  defaultKey = '',
  variant = 'tabs',
  testId,
}: TabsProps) {
  return (
    <nav
      className={variant === 'views' ? 'tabs tabs-views' : 'tabs'}
      aria-label={label}
      data-testid={testId}
    >
      <ul className="tabs-list">
        {items.map((item) => {
          const isActive = item.key === active;
          return (
            <li key={item.key || '__default'} className="tabs-item">
              <Link
                className="tabs-link"
                href={tabHref({ path, params, param, key: item.key, defaultKey })}
                aria-current={isActive ? 'page' : undefined}
                data-testid={item.testId}
                scroll={false}
              >
                <span>{item.label}</span>
                {typeof item.count === 'number' ? (
                  <span className="tabs-count">
                    {formatCount(item.count)}
                    <span className="sr-only"> kayıt</span>
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * A list's saved views ("Tümü · Başarısız · …"): the same link tabs, bound to
 * one of the list's own filter parameters rather than to `?tab=`, and drawn
 * with the design's counters.
 */
export function SavedViewTabs(props: Omit<TabsProps, 'variant'> & { param: string }) {
  return <Tabs {...props} variant="views" />;
}
