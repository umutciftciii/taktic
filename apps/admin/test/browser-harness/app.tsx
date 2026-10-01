/**
 * A browser harness for the shared form components that no screen uses yet
 * (ADMIN-DESIGN-001 Faz 2): `ConfirmDialog` and `StickyActionBar`.
 *
 * Bundled by e2e/src/component-harness.ts and served by Playwright from a fake
 * origin, so the real components run in a real engine with React 19's own form
 * actions — no Next route is added for them (every page.tsx is a screen to the
 * route scan and the menu contract). It is not a test on its own; vitest only
 * picks up `*.spec.*` files.
 *
 * What it imitates of the app, deliberately:
 * - a client router: links call `history.pushState`, and a `popstate`
 *   listener registered before the first render re-renders the route, the way
 *   Next's app router does;
 * - a "server": a form action that either saves (the page re-renders with the
 *   saved value as its default, as a revalidated server component would) or
 *   refuses and returns, leaving the old default — which is what an action
 *   returning an error state looks like after React's automatic form reset.
 *
 * Everything a test needs to read is on `window.__harness`.
 */
import { useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { StickyActionBar } from '../../components/sticky-action-bar';

type Submission = Array<[string, string]>;

type Harness = {
  /** Every submission the confirm form's action received, framework fields removed. */
  submissions: Submission[];
  /** Every save the settings form's action received. */
  saves: Submission[];
  /** `ok` saves the title; `reject` returns without saving it. */
  saveMode: 'ok' | 'reject';
  /** How many times the router rendered a new path. */
  navigations: number;
  /** Every confirmation-proof request the dialog made (the key it asked for). */
  minted: string[];
  /** `ok` hands out a proof; `refuse` answers null, as the server does without a session. */
  mintMode: 'ok' | 'refuse';
};

declare global {
  interface Window {
    __harness: Harness;
  }
}

const harness: Harness = { submissions: [], saves: [], saveMode: 'ok', navigations: 0, minted: [], mintMode: 'ok' };
window.__harness = harness;

function plainEntries(formData: FormData): Submission {
  return Array.from(formData.entries())
    .filter(([name]) => !name.startsWith('$ACTION'))
    .map(([name, value]) => [name, String(value)]);
}

// ---- the router ----------------------------------------------------------

let currentPath = window.location.pathname;
const listeners = new Set<() => void>();
function setPath(path: string) {
  currentPath = path;
  harness.navigations += 1;
  for (const listener of listeners) listener();
}
// Registered before anything renders, as the app router's is.
window.addEventListener('popstate', () => setPath(window.location.pathname));

function usePath() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => currentPath,
  );
}

function RouterLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        window.history.pushState({ path: href }, '', href);
        setPath(href);
      }}
    >
      {children}
    </a>
  );
}

// ---- the screens ---------------------------------------------------------

let serverState = { title: 'Başlık', active: true };

function SettingsScreen() {
  const [saved, setSaved] = useState(serverState);
  const title = saved.title;

  async function save(formData: FormData) {
    harness.saves.push(plainEntries(formData));
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (harness.saveMode === 'ok') {
      serverState = { title: String(formData.get('title') ?? ''), active: formData.get('active') === 'on' };
      setSaved(serverState);
    }
  }

  return (
    <main>
      <h1>Ayarlar</h1>
      <p data-testid="server-title">{title}</p>
      <form id="settings" action={save}>
        <label>
          Başlık
          <input name="title" defaultValue={title} />
        </label>
        <label>
          <input type="checkbox" name="active" defaultChecked={saved.active} />
          Etkin
        </label>
      </form>
      <RouterLink href="/other">Başka sayfa</RouterLink>
      <StickyActionBar formId="settings" testId="bar" />
    </main>
  );
}

function ConfirmScreen() {
  const [result, setResult] = useState('-');

  async function deactivate(formData: FormData) {
    const entries = plainEntries(formData);
    harness.submissions.push(entries);
    setResult(JSON.stringify(entries));
  }

  return (
    <main>
      <h1>Hesap</h1>
      <p data-testid="result">{result}</p>
      <form action={deactivate}>
        <label>
          Not
          <input name="note" />
        </label>
        <ConfirmDialog
          proof="customer.status"
          triggerLabel="Hesabı pasife al"
          title="Hesap pasife alınsın mı?"
          consequence="Kullanıcı bir daha giriş yapamaz."
          confirmLabel="Pasife al"
          name="intent"
          value="deactivate"
          testId="confirm"
        />
      </form>
    </main>
  );
}

/**
 * The Faz 3D trap, kept as a screen: a record form whose hidden field is named
 * "id" shadows `form.id`, and React 19 then drops the pressed button's
 * name/value. ConfirmDialog must still deliver it — once.
 */
function ShadowedIdScreen() {
  const [result, setResult] = useState('-');

  async function decide(formData: FormData) {
    const entries = plainEntries(formData);
    harness.submissions.push(entries);
    setResult(JSON.stringify(entries));
  }

  return (
    <main>
      <h1>Kayıt</h1>
      <p data-testid="result">{result}</p>
      <form action={decide}>
        <input type="hidden" name="id" value="rec-1" />
        <label>
          Not
          <input name="note" />
        </label>
        <ConfirmDialog
          proof="campaign.end"
          triggerLabel="Sonlandır"
          title="Kayıt sonlandırılsın mı?"
          consequence="Bu durum kalıcıdır."
          confirmLabel="Evet, sonlandır"
          name="intent"
          value="end"
          testId="confirm-shadowed"
        />
      </form>
    </main>
  );
}

function App() {
  const path = usePath();
  if (path === '/settings') return <SettingsScreen />;
  if (path === '/confirm') return <ConfirmScreen />;
  if (path === '/confirm-shadowed') return <ShadowedIdScreen />;
  return (
    <main>
      <h1 data-testid="page">{path}</h1>
      <RouterLink href="/settings">Ayarlar</RouterLink>
      <RouterLink href="/other">Başka sayfa</RouterLink>
    </main>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
