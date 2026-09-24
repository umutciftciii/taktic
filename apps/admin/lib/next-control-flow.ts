/**
 * Next's navigation signals, told apart from real failures.
 *
 * `redirect()` and `notFound()` work by throwing. `apiFetch` uses them for
 * the answers that mean "not this screen": a 401 sends the tab to /login, a
 * 403 to /yetkisiz. A `catch` that treats every throw as an error swallows
 * those. The screen then says "işlem tamamlanamadı" or "0 kayıt" about
 * something the session was never allowed to touch, or it redirects to
 * `?error=NEXT_REDIRECT`.
 *
 * Every `catch` around an API call must let these through first.
 */
export function isNextControlFlowError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const digest = (error as { digest?: unknown }).digest;
  return (
    typeof digest === 'string' &&
    (digest.startsWith('NEXT_REDIRECT') ||
      digest.startsWith('NEXT_HTTP_ERROR_FALLBACK') ||
      digest === 'NEXT_NOT_FOUND')
  );
}

/** Re-throws a Next navigation signal; does nothing for any other value. */
export function rethrowNextControlFlow(error: unknown): void {
  if (isNextControlFlowError(error)) {
    throw error;
  }
}
