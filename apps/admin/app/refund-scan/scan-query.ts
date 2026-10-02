/**
 * The preview page this screen reads: 50 rows, oldest submission first. One
 * place, because the page and the refresh after a run must read the same page
 * the same way (API-REFUND-SCAN-PAGINATION-001).
 */
export const REFUND_SCAN_PAGE_SIZE = 50;

export function scanQuery(page: number): string {
  return new URLSearchParams({ page: String(page), pageSize: String(REFUND_SCAN_PAGE_SIZE) }).toString();
}
