import type { ReactNode } from 'react';
import type { AuthUser } from '../../lib/api';
import { PanelShell } from '../panel-shell';

/**
 * The messaging screens' frame.
 *
 * A thin name over {@link PanelShell}, which is the general form: messaging was
 * the first surface both roles shared, support is the second, and the
 * role-to-sidebar decision belongs in one place rather than once per shared
 * feature. This wrapper stays because "the messaging screens are wrapped in the
 * messaging frame" is what the files that call it are actually saying.
 */
export async function MessagingFrame({ user, children }: { user: AuthUser; children: ReactNode }) {
  return (
    <PanelShell user={user} active="messages">
      {children}
    </PanelShell>
  );
}
