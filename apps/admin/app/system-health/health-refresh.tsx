'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useTransition } from 'react';

/** How often the screen re-reads itself while it is visible. */
export const SYSTEM_HEALTH_REFRESH_MS = 60_000;

/**
 * The screen's two refreshes: every minute on its own, and "Yenile" by hand.
 * Both re-render the server page (router.refresh) — no client-side fetch, no
 * second way into the API. A hidden tab does not refresh; it catches up once
 * when it is shown again, if a minute has passed. The API holds each
 * measurement for a few seconds, so pressing "Yenile" repeatedly does not
 * multiply the probes behind it.
 */
export function HealthRefresh({ generatedAtLabel }: { generatedAtLabel: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const lastRefresh = useRef(Date.now());

  const refresh = useCallback(() => {
    lastRefresh.current = Date.now();
    startTransition(() => router.refresh());
  }, [router]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, SYSTEM_HEALTH_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRefresh.current >= SYSTEM_HEALTH_REFRESH_MS) {
        refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  return (
    <div className="system-health-refresh">
      <span className="muted" data-testid="system-health-generated-at" aria-live="polite">
        {pending ? 'Yenileniyor…' : `Son ölçüm ${generatedAtLabel} · her 60 sn yenilenir`}
      </span>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={refresh}
        disabled={pending}
        data-testid="system-health-refresh"
      >
        Yenile
      </button>
    </div>
  );
}
