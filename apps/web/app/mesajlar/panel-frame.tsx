import type { ReactNode } from 'react';
import { apiFetch, type AuthUser, type ProviderDashboard } from '../../lib/api';
import { CustomerShell } from '../requests/customer-shell';
import { ProviderShell } from '../providers/provider-shell';
import { readCreditBalance } from '../providers/provider-data';

/**
 * One messaging screen, rendered inside whichever panel the viewer belongs to.
 *
 * Messaging is the first surface both roles share, and duplicating the screens
 * per role would mean two copies of a thread list and two copies of a
 * conversation drifting apart. Instead the screen is written once and the frame
 * around it is chosen here — the customer keeps their sidebar, the provider
 * keeps theirs (credit box included), and neither learns anything about the
 * other's panel.
 */
export async function MessagingFrame({
  user,
  children,
}: {
  user: AuthUser;
  children: ReactNode;
}) {
  if (user.role === 'PROVIDER') {
    const providerId = await readProviderId();
    const creditBalance = providerId ? await readCreditBalance(providerId) : null;

    return (
      <ProviderShell
        user={user}
        providerId={providerId}
        active="messages"
        creditBalance={creditBalance}
      >
        {children}
      </ProviderShell>
    );
  }

  return (
    <CustomerShell user={user} active="messages">
      {children}
    </CustomerShell>
  );
}

/**
 * The signed-in provider's own profile id, or null when it cannot be read.
 *
 * Null is a real state — a provider account with no profile yet — and the
 * sidebar already knows how to render itself without one, so a failure here
 * costs the conversation nothing.
 */
async function readProviderId(): Promise<string | null> {
  try {
    const dashboard = await apiFetch<ProviderDashboard>('/providers/me/dashboard');
    return dashboard.provider?.id ?? null;
  } catch {
    return null;
  }
}
