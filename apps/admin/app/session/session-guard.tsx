'use client';

import { safeRedirectPathOrNull } from '@taktic/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { announceSessionEnded, onSessionEnded } from './session-channel';

/**
 * Watches the signed-in session, warns before it ends, and gets out of the way
 * when it does.
 *
 * Three properties this component is built around, in order of importance:
 *
 * **The server decides.** Nothing here ends a session; the API refuses the next
 * request whatever this component concluded. What it does is notice, so the
 * person is told rather than discovering it as a form that failed to submit.
 *
 * **The browser's clock is not consulted.** Every countdown is measured with
 * `performance.now()` — a monotonic clock the page cannot be talked out of —
 * against a remaining time the server stated. Moving the operating system clock
 * forward by a day changes nothing on screen, and moving it back keeps nothing
 * alive: the next poll still asks the machine that decides. `Date.now()` is
 * deliberately absent from this file.
 *
 * **Polling costs a session nothing.** The status read never records activity,
 * so a tab left open cannot keep an unattended browser signed in. Activity is
 * recorded only by real interaction (throttled) or by somebody clicking "devam
 * et", which is exactly the difference between a person being there and a page
 * being open.
 */

type SessionStatus = {
  rememberMe: boolean;
  absoluteExpiresAt: string;
  idleExpiresAt: string;
  expiresAt: string;
  idleTimeoutSeconds: number;
  idleWarningSeconds: number;
  serverTime: string;
};

type SessionGuardProps = {
  /** Where an ended session sends the browser. */
  loginPath?: string;
  /**
   * Whether to hand the current path back as `redirectTo`.
   *
   * Off by default here: the admin sign-in form has no destination parameter,
   * so putting a path in the URL would be a value nothing reads — and one that
   * puts the screen an operator was on into their address bar and their
   * browser history for no benefit.
   */
  preserveDestination?: boolean;
};

/** How often the tab asks the server how it is doing, while it is visible. */
const POLL_INTERVAL_MS = 30_000;

/**
 * The shortest gap between two activity heartbeats. It matches the server's own
 * touch interval: writing more often would only produce writes the server
 * discards.
 */
const TOUCH_INTERVAL_MS = 5 * 60_000;

/** How often the countdown on screen is redrawn once the warning is up. */
const COUNTDOWN_TICK_MS = 1_000;

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export function SessionGuard({
  loginPath = '/login',
  preserveDestination = false,
}: SessionGuardProps) {
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [warning, setWarning] = useState(false);
  const [extending, setExtending] = useState(false);

  /**
   * The only time reference this component keeps: how long the server said was
   * left, and the monotonic reading at the moment it said so.
   */
  const anchor = useRef<{ remainingMs: number; at: number; warnAtMs: number } | null>(null);
  const endedRef = useRef(false);
  const lastTouchRef = useRef<number>(-Infinity);

  const endSession = useCallback(() => {
    if (endedRef.current) {
      return;
    }
    endedRef.current = true;

    // Every other tab of this application, immediately rather than at its own
    // next poll.
    announceSessionEnded();

    const params = new URLSearchParams({ reason: 'session-expired' });
    if (preserveDestination) {
      // Read off this window rather than trusted for being read off this
      // window: the address bar is the one place a destination could have been
      // planted, and it goes through the same check as every other
      // `redirectTo` in the product. See @taktic/shared's safe-redirect.
      const destination = safeRedirectPathOrNull(
        `${window.location.pathname}${window.location.search}`,
      );
      if (destination && destination !== loginPath) {
        params.set('redirectTo', destination);
      }
    }

    // A full navigation, not a router push: the session is gone, so every
    // client-side cache of a signed-in screen has to go with it.
    window.location.replace(`${loginPath}?${params.toString()}`);
  }, [loginPath, preserveDestination]);

  const applyStatus = useCallback((status: SessionStatus) => {
    const remainingMs = Date.parse(status.expiresAt) - Date.parse(status.serverTime);
    anchor.current = {
      // Both timestamps come from the server, so their difference is a duration
      // the browser's own clock plays no part in.
      remainingMs: Number.isFinite(remainingMs) ? remainingMs : 0,
      at: performance.now(),
      // The server's figure for *this* session's policy: two minutes for an
      // ordinary one, a day for a remembered one. Never a constant here — a
      // month-long session warned two minutes out would be warning an empty
      // room.
      warnAtMs: status.idleWarningSeconds * 1000,
    };
  }, []);

  /** Reads the session's remaining life without spending any of it. */
  const poll = useCallback(async () => {
    if (endedRef.current) {
      return;
    }

    let response: Response;
    try {
      response = await fetch('/api/session', { cache: 'no-store' });
    } catch {
      // Offline, or the tab was suspended mid-flight. Not a verdict — the
      // session may be perfectly alive, and throwing somebody out over a
      // dropped request would be the wrong call every time it happened.
      return;
    }

    if (response.status === 401) {
      endSession();
      return;
    }

    if (!response.ok) {
      return;
    }

    applyStatus((await response.json()) as SessionStatus);
  }, [applyStatus, endSession]);

  /** Records activity, and takes the extended window as the new anchor. */
  const touch = useCallback(async () => {
    if (endedRef.current) {
      return false;
    }

    let response: Response;
    try {
      response = await fetch('/api/session', { method: 'POST', cache: 'no-store' });
    } catch {
      return false;
    }

    if (response.status === 401) {
      endSession();
      return false;
    }

    if (!response.ok) {
      return false;
    }

    applyStatus((await response.json()) as SessionStatus);
    setWarning(false);
    return true;
  }, [applyStatus, endSession]);

  // ---- the countdown ------------------------------------------------------
  useEffect(() => {
    void poll();

    const tick = () => {
      const current = anchor.current;
      if (!current || endedRef.current) {
        return;
      }

      const left = current.remainingMs - (performance.now() - current.at);
      const shouldWarn = left <= current.warnAtMs;

      // State is only written while the warning is up, or as it appears and
      // disappears. A remembered session is a month long, and re-rendering the
      // whole panel once a second for four weeks to update a number nobody is
      // being shown is a cost with no reader.
      setWarning((was) => (was === shouldWarn ? was : shouldWarn));
      if (shouldWarn) {
        setRemainingSeconds(Math.max(0, Math.ceil(left / 1000)));
      }

      // The countdown reaching zero is a prompt to ask, never the answer. The
      // server is what says the session is over, so the tab confirms before it
      // throws anybody out — and a monotonic clock that ran fast cannot sign
      // somebody out on its own.
      if (left <= 0) {
        void poll();
      }
    };

    const countdown = window.setInterval(tick, COUNTDOWN_TICK_MS);
    return () => window.clearInterval(countdown);
  }, [poll]);

  // ---- polling, only while the tab is actually being looked at ------------
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void poll();
      }
    }, POLL_INTERVAL_MS);

    // Coming back to a backgrounded tab is the moment its picture is most
    // likely to be stale, so it re-reads immediately rather than waiting.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void poll();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [poll]);

  // ---- activity, throttled hard -------------------------------------------
  useEffect(() => {
    const onActivity = () => {
      const now = performance.now();
      if (now - lastTouchRef.current < TOUCH_INTERVAL_MS) {
        return;
      }
      lastTouchRef.current = now;
      void touch();
    };

    // Deliberately not `mousemove` or `scroll`: a cursor crossing the window
    // and a page settling after load are not somebody using the application,
    // and treating them as activity is how an idle timeout quietly stops
    // existing. Only events a person causes on purpose count — and even those
    // are collapsed to one heartbeat per five minutes.
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onActivity, { passive: true });
    }

    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, onActivity);
      }
    };
  }, [touch]);

  // ---- other tabs ---------------------------------------------------------
  useEffect(() => onSessionEnded(endSession), [endSession]);

  if (!warning || remainingSeconds === null) {
    return null;
  }

  return (
    <div className="session-warning" role="alertdialog" aria-live="assertive" data-testid="session-warning">
      <div className="session-warning-card">
        <h2 className="session-warning-title">Oturumunuz sona ermek üzere</h2>
        <p className="session-warning-body">
          Bir süredir işlem yapılmadı. Güvenliğiniz için oturum{' '}
          <strong data-testid="session-warning-countdown">{formatCountdown(remainingSeconds)}</strong>{' '}
          içinde kapanacak.
        </p>
        <div className="session-warning-actions">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="session-warning-extend"
            disabled={extending}
            onClick={async () => {
              setExtending(true);
              try {
                await touch();
              } finally {
                setExtending(false);
              }
            }}
          >
            {extending ? 'Sürdürülüyor…' : 'Oturuma devam et'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            data-testid="session-warning-logout"
            onClick={endSession}
          >
            Çıkış yap
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The time left, in the largest unit that is still meaningful.
 *
 * A remembered session is warned about a day before it ends, so this has to be
 * able to say "1 gün" as well as "45 saniye" — "1440 dakika" is a number nobody
 * reads as a day. Only the top two units are shown: at that distance the seconds
 * are noise, and at the very end they are the whole message.
 */
function formatCountdown(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;

  if (days > 0) {
    return hours === 0 ? `${days} gün` : `${days} gün ${hours} saat`;
  }

  if (hours > 0) {
    return minutes === 0 ? `${hours} saat` : `${hours} saat ${minutes} dk`;
  }

  if (minutes > 0) {
    return rest === 0 ? `${minutes} dakika` : `${minutes} dk ${rest} sn`;
  }

  return `${seconds} saniye`;
}
