/**
 * The arithmetic behind the shared `Pagination` component.
 *
 * Two kinds of list exist in this panel. A page-based one knows its total and
 * can say "148 kaydın 51–100 arası"; a cursor-based one only knows whether
 * there is a next and a previous page, and must not pretend to know a total it
 * was never given. Both summaries are written here so every list words them
 * the same way.
 */

export type PageWindow = {
  page: number;
  pageSize: number;
  total: number;
  /** 1-based index of the first row on this page, 0 when the page is empty. */
  start: number;
  /** 1-based index of the last row on this page, 0 when the page is empty. */
  end: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
  /** A page number past the last row — reachable by editing the URL. */
  outOfRange: boolean;
};

const countFormat = new Intl.NumberFormat('tr-TR');

export function formatCount(value: number): string {
  return countFormat.format(value);
}

export function pageWindow({
  page,
  pageSize,
  total,
  hasNextPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  /** The API's own answer, when it gives one; otherwise derived from the total. */
  hasNextPage?: boolean;
}): PageWindow {
  const safeSize = Math.max(1, Math.floor(pageSize));
  const safeTotal = Math.max(0, Math.floor(total));
  const safePage = Math.max(1, Math.floor(page));
  const totalPages = Math.max(1, Math.ceil(safeTotal / safeSize));
  const firstIndex = (safePage - 1) * safeSize + 1;
  const outOfRange = safeTotal > 0 && firstIndex > safeTotal;
  const empty = safeTotal === 0 || outOfRange;
  const start = empty ? 0 : firstIndex;
  const end = empty ? 0 : Math.min(safePage * safeSize, safeTotal);

  return {
    page: safePage,
    pageSize: safeSize,
    total: safeTotal,
    start,
    end,
    totalPages,
    hasPrevious: safePage > 1,
    hasNext: hasNextPage ?? (!empty && end < safeTotal),
    outOfRange,
  };
}

/** "148 kaydın 1–50 arası gösteriliyor", or what to say when there is nothing. */
export function pageSummary(window: PageWindow, noun = 'kayıt'): string {
  if (window.total === 0) return `0 ${noun}`;
  if (window.total === 1 && window.start === 1) return `1 ${noun}`;
  if (window.outOfRange) {
    return `Bu sayfada ${noun} yok · toplam ${formatCount(window.total)} ${noun}`;
  }
  if (window.start === window.end) {
    return `${formatCount(window.total)} kaydın ${formatCount(window.start)}. kaydı gösteriliyor`;
  }
  return `${formatCount(window.total)} kaydın ${formatCount(window.start)}–${formatCount(window.end)} arası gösteriliyor`;
}

/**
 * A cursor list knows how many rows it holds; how many exist only when the API
 * counted them and said so (`total`). Never a guessed total.
 */
export function cursorSummary(count: number, noun = 'kayıt', total?: number): string {
  if (total === undefined) {
    return count === 0 ? `Bu sayfada ${noun} yok` : `Bu sayfada ${formatCount(count)} ${noun}`;
  }
  if (total === 0) return `0 ${noun}`;
  return count === 0
    ? `Bu sayfada ${noun} yok · toplam ${formatCount(total)} ${noun}`
    : `Toplam ${formatCount(total)} ${noun} · bu sayfada ${formatCount(count)}`;
}
