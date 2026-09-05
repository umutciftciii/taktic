import type { ReactNode } from 'react';
import { apiFetch, type AuthUser, type ProviderDashboard } from '../lib/api';
import { CustomerShell } from './requests/customer-shell';
import { ProviderShell } from './providers/provider-shell';
import { readCreditBalance } from './providers/provider-data';

/**
 * The sections both panels have, named once.
 *
 * Every screen that serves hizmet alan and hizmet veren from the same route
 * passes one of these, and each shell maps it onto its own nav key. Keeping the
 * list here rather than accepting each shell's own union means a section that
 * exists in only one panel cannot be asked for by a shared screen.
 */
export type SharedPanelSection = 'messages' | 'support';

/**
 * One screen, rendered inside whichever panel the viewer belongs to.
 *
 * Messaging was the first surface the two roles shared and support is the
 * second, and duplicating a screen per role is how two copies of a thread list
 * — or of a ticket timeline — drift apart. Instead each shared screen is
 * written once and the frame around it is chosen here: the hizmet alan keeps
 * their sidebar, the hizmet veren keeps theirs (credit box included), and
 * neither learns anything about the other's panel.
 *
 * This decides the *frame*, never the *contents*. Who may read a ticket is the
 * API's answer, enforced by the ownership scope on every query; a page that got
 * this wrong would draw the wrong sidebar, not show somebody else's ticket.
 */
export async function PanelShell({
  user,
  active,
  children,
}: {
  user: AuthUser;
  active: SharedPanelSection;
  children: ReactNode;
}) {
  if (user.role === 'PROVIDER') {
    const providerId = await readProviderId();
    const creditBalance = providerId ? await readCreditBalance(providerId) : null;

    return (
      <ProviderShell
        user={user}
        providerId={providerId}
        active={active}
        creditBalance={creditBalance}
      >
        {children}
      </ProviderShell>
    );
  }

  return (
    <CustomerShell user={user} active={active}>
      {children}
    </CustomerShell>
  );
}

/**
 * The signed-in provider's own profile id, or null when it cannot be read.
 *
 * Null is a real state — a provider account with no profile yet — and the
 * sidebar already knows how to render itself without one, so a failure here
 * costs the screen inside the frame nothing.
 */
async function readProviderId(): Promise<string | null> {
  try {
    const dashboard = await apiFetch<ProviderDashboard>('/providers/me/dashboard');
    return dashboard.provider?.id ?? null;
  } catch {
    return null;
  }
}
