import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CREDIT_AMOUNT_MAX, parseCreditAmount } from '../lib/credit-amount';

/**
 * ADMIN-DESIGN-001 Faz 3B (PR #122 review): the manual credit amount has one
 * reading, shared by the form's preview, its confirmation and the server
 * action. The bug this pins: the form read "1e2" with parseInt (1) and the
 * action with Number (100), so the dialog promised 1 credit and the API was
 * sent 100.
 */

const apiFetch = vi.fn();
vi.mock('../lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly body: string,
    ) {
      super(body);
    }
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// The confirmation proof has its own spec (destructive-confirmation-proof);
// here every submission is taken as confirmed.
vi.mock('../lib/confirmation-proof-server', () => ({ hasConfirmationProof: vi.fn(async () => true) }));

const { submitCreditOperationAction } = await import('../app/providers/[id]/credits/actions');
const { ApiError } = await import('../lib/api');
const { CREDIT_OPERATION_IDLE } = await import('../app/providers/[id]/credits/credit-operation-state');

describe('parseCreditAmount', () => {
  it('reads digits as the integer they spell, and nothing else', () => {
    expect(parseCreditAmount('50')).toEqual({ ok: true, value: 50 });
    expect(parseCreditAmount(' 12 ')).toEqual({ ok: true, value: 12 });
    expect(parseCreditAmount('050')).toEqual({ ok: true, value: 50 });
    expect(parseCreditAmount(String(CREDIT_AMOUNT_MAX))).toEqual({ ok: true, value: CREDIT_AMOUNT_MAX });
  });

  it.each(['1e2', '1E2', '2.5', '2,5', '1.0', '+3', '-3', '0x10', '1 0', '١٢', 'Infinity', 'NaN', 'abc', '12a'])(
    'refuses %s as a format error',
    (raw) => {
      expect(parseCreditAmount(raw)).toEqual({ ok: false, problem: 'format' });
    },
  );

  it('refuses empty input, zero and anything past the ledger column', () => {
    expect(parseCreditAmount('')).toEqual({ ok: false, problem: 'empty' });
    expect(parseCreditAmount('   ')).toEqual({ ok: false, problem: 'empty' });
    expect(parseCreditAmount(null)).toEqual({ ok: false, problem: 'empty' });
    expect(parseCreditAmount('0')).toEqual({ ok: false, problem: 'range' });
    expect(parseCreditAmount('000')).toEqual({ ok: false, problem: 'range' });
    expect(parseCreditAmount(String(CREDIT_AMOUNT_MAX + 1))).toEqual({ ok: false, problem: 'range' });
    expect(parseCreditAmount(String(Number.MAX_SAFE_INTEGER))).toEqual({ ok: false, problem: 'range' });
    expect(parseCreditAmount('9'.repeat(400))).toEqual({ ok: false, problem: 'range' });
  });
});

function form(amount: string, operationType: 'GRANT' | 'DEDUCT' = 'GRANT') {
  const data = new FormData();
  data.set('providerId', 'provider-1');
  data.set('operationType', operationType);
  data.set('amount', amount);
  data.set('reason', 'Birim test gerekçesi');
  return data;
}

describe('submitCreditOperationAction, called directly', () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it.each(['1e2', '2.5', '', '0', '-5', String(CREDIT_AMOUNT_MAX + 1), '9007199254740993'])(
    'refuses %j without calling the API, so nothing is recorded',
    async (amount) => {
      const state = await submitCreditOperationAction(CREDIT_OPERATION_IDLE, form(amount, 'DEDUCT'));
      expect(state.kind).toBe('error');
      expect(apiFetch).not.toHaveBeenCalled();
    },
  );

  it('sends the validated integer and reports the amount the ledger recorded', async () => {
    apiFetch.mockResolvedValue({ amount: -7, balanceAfter: 33 });
    const state = await submitCreditOperationAction(CREDIT_OPERATION_IDLE, form(' 007 ', 'DEDUCT'));

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetch.mock.calls[0] as [string, { body: string }];
    expect(path).toBe('/providers/provider-1/credits/deduct');
    expect(JSON.parse(init.body)).toEqual({ amount: 7, reason: 'Birim test gerekçesi' });
    expect(state).toMatchObject({ kind: 'done', operation: 'DEDUCT', amount: 7, balanceAfter: 33 });
  });

  it('explains a balance-limit refusal with the API\'s current balance, not the page\'s', async () => {
    apiFetch.mockRejectedValue(
      new ApiError(
        400,
        JSON.stringify({ code: 'CREDIT_BALANCE_LIMIT_EXCEEDED', currentBalance: CREDIT_AMOUNT_MAX - 3, maxBalance: CREDIT_AMOUNT_MAX }),
      ),
    );
    const state = await submitCreditOperationAction(CREDIT_OPERATION_IDLE, form('10'));
    expect(state).toMatchObject({ kind: 'error' });
    const message = state.kind === 'error' ? state.message : '';
    expect(message).toContain('üst sınırını aşardı');
    expect(message).toContain('en fazla 3 kredi eklenebilir');
  });

  it('turns a 409 write conflict into a retry message rather than a failure page', async () => {
    apiFetch.mockRejectedValue(new ApiError(409, JSON.stringify({ code: 'CONCURRENT_MODIFICATION' })));
    const state = await submitCreditOperationAction(CREDIT_OPERATION_IDLE, form('10'));
    expect(state.kind === 'error' ? state.message : '').toContain('aynı anda');
  });

  it('reads its bound from the shared limits file the API reads', async () => {
    const limits = (await import('@taktic/shared/limits.json')).default;
    expect(CREDIT_AMOUNT_MAX).toBe(limits.creditLedgerIntegerMax);
    expect(CREDIT_AMOUNT_MAX).toBe(2_147_483_647);
  });
});
