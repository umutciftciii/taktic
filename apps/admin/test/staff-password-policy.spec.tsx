import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import policy from '@taktic/shared/staff-password-policy.json';
import { submitAdminInvite } from '../app/admin-invite/accept-invite';
import AdminInvitePage from '../app/admin-invite/page';
import { PasswordFields } from '../app/password-criteria';
import { confirmPasswordReset } from '../app/sifre-sifirla/confirm-reset';
import ResetPasswordPage from '../app/sifre-sifirla/page';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_DISTINCT_CHARACTERS,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULE_MESSAGES,
  passwordCriteria,
  passwordRuleMessage,
  passwordViolations,
} from '../lib/password-policy';

/**
 * ADMIN-AUTH-002 — the staff password rule, as the panel shows and pre-checks it.
 *
 * The API enforces the rule (apps/api/test/staff-password-policy.spec.ts); what
 * is pinned here is that the panel reads the same table, lists every rule as a
 * criterion, checks it before sending, and words a refusal — its own or the
 * API's — with the shared sentence.
 */

const GOOD = 'Dort-mavi-kedi-bulutta-7';

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the shared table', () => {
  it('is 20–128 characters, with the sentences stating the same numbers', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(20);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
    expect(PASSWORD_MIN_DISTINCT_CHARACTERS).toBe(policy.minDistinctCharacters);
    expect(PASSWORD_RULE_MESSAGES.minLength).toContain(`${PASSWORD_MIN_LENGTH} karakter`);
    expect(PASSWORD_RULE_MESSAGES.maxLength).toContain(`${PASSWORD_MAX_LENGTH} karakter`);
    expect(PASSWORD_RULE_MESSAGES.distinctCharacters).toContain(`${PASSWORD_MIN_DISTINCT_CHARACTERS} farklı`);
  });
});

describe('passwordViolations', () => {
  it('accepts a long passphrase with no character-class requirement', () => {
    expect(passwordViolations(GOOD)).toEqual([]);
    expect(passwordViolations('dört mavi kedi bulutta uyuyor')).toEqual([]);
  });

  it('pins the length boundaries', () => {
    const nineteen = 'abcdefghijklmnopqrs';
    expect(nineteen).toHaveLength(19);
    expect(passwordViolations(nineteen)).toEqual(['minLength']);
    expect(passwordViolations(`${nineteen}t`)).toEqual([]);
    const max = `${'abcdefghij'.repeat(12)}klmnopqr`;
    expect(max).toHaveLength(128);
    expect(passwordViolations(max)).toEqual([]);
    expect(passwordViolations(`${max}s`)).toEqual(['maxLength']);
  });

  it('refuses a repetitive value however long', () => {
    expect(passwordViolations('ab'.repeat(15))).toEqual(['distinctCharacters']);
  });

  it('refuses a guessable word in either case, Turkish letters included', () => {
    expect(passwordViolations('Benim-ADMIN-hesabim-9x')).toEqual(['guessable']);
    expect(passwordViolations('YENİ-ŞİFRE-bulut-mavi-7')).toEqual(['guessable']);
    expect(passwordViolations('kedi-taktick-bulut-mavi-7')).toEqual(['guessable']);
  });

  it('lists every broken rule in order', () => {
    expect(passwordViolations('admin')).toEqual(['minLength', 'distinctCharacters', 'guessable']);
  });
});

describe('the criteria the form lists', () => {
  it('ticks each criterion only when its rule is met', () => {
    const empty = passwordCriteria('', '');
    expect(empty.map((criterion) => criterion.key)).toEqual(['length', 'distinct', 'guessable', 'match']);
    expect(empty.every((criterion) => !criterion.met)).toBe(true);

    const met = passwordCriteria(GOOD, GOOD);
    expect(met.every((criterion) => criterion.met)).toBe(true);

    const short = passwordCriteria('Kisa-sifre-1', 'Kisa-sifre-1');
    expect(short.find((criterion) => criterion.key === 'length')?.met).toBe(false);
    expect(short.find((criterion) => criterion.key === 'match')?.met).toBe(true);
  });

  it('renders the four criteria, with the length bounds on both inputs', () => {
    const html = renderToStaticMarkup(<PasswordFields />);
    expect(html).toContain(`En az ${PASSWORD_MIN_LENGTH}, en fazla ${PASSWORD_MAX_LENGTH} karakter`);
    expect(html).toContain(`En az ${PASSWORD_MIN_DISTINCT_CHARACTERS} farklı karakter`);
    expect(html).toContain('tahmin edilebilir kelime yok');
    expect(html).toContain('Şifreler eşleşiyor');
    expect(html.match(new RegExp(`minLength="${PASSWORD_MIN_LENGTH}"`, 'g'))).toHaveLength(2);
    expect(html.match(new RegExp(`maxLength="${PASSWORD_MAX_LENGTH}"`, 'g'))).toHaveLength(2);
    for (const key of ['length', 'distinct', 'guessable', 'match']) {
      expect(html).toContain(`data-testid="password-criterion-${key}"`);
    }
  });
});

describe('accepting an invite', () => {
  it('checks the staff rule before calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await submitAdminInvite(form({ token: 't1', password: 'Sekiz123', passwordConfirm: 'Sekiz123' }))).toBe(
      '/admin-invite?token=t1&error=policy&rule=minLength',
    );
    const guessable = 'Benim-admin-hesabim-mavi-9';
    expect(await submitAdminInvite(form({ token: 't1', password: guessable, passwordConfirm: guessable }))).toBe(
      '/admin-invite?token=t1&error=policy&rule=guessable',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('carries the rule the API named, not its text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(400, { code: 'STAFF_PASSWORD_POLICY', message: 'whatever', rules: ['distinctCharacters'] }),
      ),
    );
    expect(await submitAdminInvite(form({ token: 't1', password: GOOD, passwordConfirm: GOOD }))).toBe(
      '/admin-invite?token=t1&error=policy&rule=distinctCharacters',
    );
  });

  it('shows the shared sentence for the rule on the form', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, { valid: true, user: { name: 'Ops', email: 'ops@example.test' }, expiresAt: '2026-10-18T12:30:00.000Z' }),
      ),
    );
    const html = renderToStaticMarkup(
      await AdminInvitePage({ searchParams: Promise.resolve({ token: 't1', error: 'policy', rule: 'minLength' }) }),
    );
    expect(html).toContain(PASSWORD_RULE_MESSAGES.minLength);
    expect(html).toContain('role="alert"');
  });
});

describe('completing a reset link', () => {
  it('carries the rule the API named, and keeps one message for a dead link', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { code: 'STAFF_PASSWORD_POLICY', message: 'x', rules: ['guessable', 'minLength'] }),
    );
    expect(await confirmPasswordReset(form({ token: 't1', password: GOOD, passwordConfirm: GOOD }))).toBe(
      '/sifre-sifirla?token=t1&error=policy&rule=guessable',
    );

    // A rule key the panel does not know is not trusted into the URL.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { code: 'STAFF_PASSWORD_POLICY', message: 'x', rules: ['<script>'] }),
    );
    expect(await confirmPasswordReset(form({ token: 't1', password: GOOD, passwordConfirm: GOOD }))).toBe(
      '/sifre-sifirla?token=t1&error=submit',
    );

    fetchMock.mockResolvedValueOnce(jsonResponse(400, { message: 'Bağlantı geçersiz veya süresi dolmuş.' }));
    expect(await confirmPasswordReset(form({ token: 't1', password: GOOD, passwordConfirm: GOOD }))).toBe(
      '/sifre-sifirla?token=t1&error=submit',
    );
  });

  it('shows the shared sentence, and falls back to the length rule for an unknown key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        jsonResponse(200, { valid: true, email: 'ops@example.test', expiresAt: '2026-10-18T12:30:00.000Z' }),
      ),
    );
    const guessable = renderToStaticMarkup(
      await ResetPasswordPage({ searchParams: Promise.resolve({ token: 't1', error: 'policy', rule: 'guessable' }) }),
    );
    expect(guessable).toContain(
      renderToStaticMarkup(<>{PASSWORD_RULE_MESSAGES.guessable}</>),
    );

    const unknown = renderToStaticMarkup(
      await ResetPasswordPage({ searchParams: Promise.resolve({ token: 't1', error: 'policy', rule: 'bogus' }) }),
    );
    expect(unknown).toContain(PASSWORD_RULE_MESSAGES.minLength);
    expect(passwordRuleMessage(undefined)).toBe(PASSWORD_RULE_MESSAGES.minLength);
  });
});
