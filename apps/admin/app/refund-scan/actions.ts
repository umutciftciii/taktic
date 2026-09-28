'use server';

import { ApiError, apiFetch, type RefundScanExecuteResponse, type RefundScanResponse } from '../../lib/api';
import { rethrowNextControlFlow } from '../../lib/next-control-flow';

/**
 * The refund scan's two calls, made from this server rather than the browser.
 *
 * The endpoints, the bodies and the permissions are the ones the screen always
 * used — `GET /offers/refund-scan?limit` (OFFER_REFUND_SCAN_READ) and
 * `POST /offers/refund-scan/execute {limit}` (OFFER_REFUND_EXECUTE). What moved
 * is the caller. The browser used to call the API directly at an address
 * inlined when the app was built, which is the one place this panel did so:
 * every other admin write is a server action through `apiFetch`, which reads
 * the API's address at run time and turns a 401/403 into the sign-in form or
 * /yetkisiz instead of printing the API's raw refusal.
 *
 * A refusal the operator can act on (a limit out of range, a failed run) comes
 * back as a message; a navigation (401/403) is rethrown for Next to follow.
 */

export type RefundScanActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function refreshRefundScanAction(limit: number): Promise<RefundScanActionResult<RefundScanResponse>> {
  try {
    const query = new URLSearchParams({ limit: String(limit) });
    return { ok: true, data: await apiFetch<RefundScanResponse>(`/offers/refund-scan?${query.toString()}`) };
  } catch (error) {
    return refusal(error, 'Tarama başarısız');
  }
}

export async function executeRefundScanAction(
  limit: number,
): Promise<RefundScanActionResult<RefundScanExecuteResponse>> {
  try {
    return {
      ok: true,
      data: await apiFetch<RefundScanExecuteResponse>('/offers/refund-scan/execute', {
        method: 'POST',
        body: JSON.stringify({ limit }),
      }),
    };
  } catch (error) {
    return refusal(error, 'Çalıştırma başarısız');
  }
}

function refusal(error: unknown, fallback: string): { ok: false; error: string } {
  rethrowNextControlFlow(error);
  if (error instanceof ApiError) {
    return { ok: false, error: error.body || `${fallback} (${error.status})` };
  }
  throw error;
}
