import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ADMIN-DESTRUCTIVE-CONFIRMATION-001 — Faz 2: the API's two authoritative
 * refusals, read by the real `readConflict`.
 *
 * - 409 ACTIVATION_LINK_ALREADY_ACTIVE: an access link was asked for without
 *   consent while one is live. The form switches to the confirmed reissue and
 *   says why; nothing was written.
 * - 409 REQUEST_STATUS_CHANGED: "İncelemeye al" was decided against a status
 *   the request no longer has. The screen explains it; nothing was written.
 */

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ name: 'taktic_session', value: 's' }), toString: () => '' }),
}));

class Redirect extends Error {
  readonly digest: string;
  constructor(readonly url: string) {
    super('NEXT_REDIRECT');
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const apiFetch = vi.fn();
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

const { ApiError } = await import('../lib/api');
const conflict = (code: string) => new ApiError(409, JSON.stringify({ statusCode: 409, code, message: 'x' }));

beforeEach(() => {
  apiFetch.mockReset();
});

describe('409 ACTIVATION_LINK_ALREADY_ACTIVE', () => {
  it('turns into the reissue state with a sentence of its own', async () => {
    apiFetch.mockImplementation(async () => {
      throw conflict('ACTIVATION_LINK_ALREADY_ACTIVE');
    });
    const { createCustomerActivationLinkAction } = await import('../app/customers/actions');
    const data = new FormData();
    data.set('customerId', 'c-1');
    const state = await createCustomerActivationLinkAction({ kind: 'idle' }, data);
    expect(state).toEqual({
      kind: 'error',
      message: expect.stringContaining('henüz kullanılmamış, geçerli bir şifre belirleme bağlantısı var'),
      reissue: true,
    });
  });
});

describe('409 REQUEST_STATUS_CHANGED', () => {
  it('lands on the status card with the stale-decision message', async () => {
    apiFetch.mockImplementation(async (_path: string, init?: { method?: string }) => {
      if (!init?.method) return { status: 'SUBMITTED' };
      throw conflict('REQUEST_STATUS_CHANGED');
    });
    const { updateRequestStatusAction } = await import('../app/requests/actions');
    const data = new FormData();
    data.set('id', 'rq-1');
    data.set('status', 'IN_REVIEW');
    await expect(updateRequestStatusAction(data)).rejects.toMatchObject({
      url: '/requests/rq-1?statusError=statusChanged',
    });
    const { requestStatusErrorMessage } = await import('../lib/status-conflicts');
    expect(requestStatusErrorMessage('statusChanged')).toContain('eski duruma göre verildiği için uygulanmadı');
  });
});
