import { describe, expect, it } from 'vitest';
import { identityReducer, type IdentityAction, type IdentityState } from '../app/request-fields/identity-check';

const base: IdentityState = { status: 'idle', seq: 0, phone: '', email: '' };

function run(actions: IdentityAction[], from: IdentityState = base): IdentityState {
  return actions.reduce(identityReducer, from);
}

describe('identityReducer', () => {
  it('starts a check with a new sequence number', () => {
    const next = identityReducer(base, { type: 'start', phone: '0555', email: 'a@x.test' });
    expect(next).toEqual({ status: 'checking', seq: 1, phone: '0555', email: 'a@x.test' });
  });

  it('applies only the latest response', () => {
    const one = identityReducer(base, { type: 'start', phone: '0555', email: 'a@x.test' });
    const two = identityReducer(one, { type: 'start', phone: '0555', email: 'b@x.test' });
    const stale = identityReducer(two, { type: 'result', seq: 1, status: 'ok' });
    expect(stale.status).toBe('checking');
    const fresh = identityReducer(two, { type: 'result', seq: 2, status: 'login-required' });
    expect(fresh.status).toBe('login-required');
  });

  it('falls back to idle when the phone or e-mail changes', () => {
    const ok = run([
      { type: 'start', phone: '0555', email: 'a@x.test' },
      { type: 'result', seq: 1, status: 'ok' },
    ]);
    expect(identityReducer(ok, { type: 'fields', phone: '0556', email: 'a@x.test' }).status).toBe('idle');
    expect(identityReducer(ok, { type: 'fields', phone: '0555', email: 'a@x.test' }).status).toBe('ok');
  });

  it('never applies an answer that was asked about a pair the customer has since changed', () => {
    // A call is in flight for pair A; the number changes to B before it
    // answers. The answer that then arrives carries A's sequence number and
    // must not open the gate for B — B was never checked.
    const state = run([
      { type: 'start', phone: '0555', email: 'a@x.test' },
      { type: 'fields', phone: '0556', email: 'a@x.test' },
      { type: 'result', seq: 1, status: 'ok' },
    ]);
    expect(state.status).toBe('idle');
    expect(state.phone).toBe('0556');
    // The same for a refusal: it neither opens nor shuts a gate it was not asked about.
    expect(run([
      { type: 'start', phone: '0555', email: 'a@x.test' },
      { type: 'fields', phone: '0555', email: 'b@x.test' },
      { type: 'result', seq: 1, status: 'login-required' },
    ]).status).toBe('idle');
    // And the next check the new pair starts is numbered after the change, so
    // even a very late answer for A can never match it.
    const next = identityReducer(state, { type: 'start', phone: '0556', email: 'a@x.test' });
    expect(next.seq).toBeGreaterThan(1);
    expect(identityReducer(next, { type: 'result', seq: 1, status: 'ok' }).status).toBe('checking');
  });

  it('applies the answer when the fields were re-reported unchanged', () => {
    // The hook reports the fields on every render they are part of; the same
    // values are not a change and do not discard the running check.
    const state = run([
      { type: 'start', phone: '0555', email: 'a@x.test' },
      { type: 'fields', phone: '0555', email: 'a@x.test' },
      { type: 'result', seq: 1, status: 'ok' },
    ]);
    expect(state.status).toBe('ok');
  });

  it('turns a failed call into error, never ok', () => {
    const checking = identityReducer(base, { type: 'start', phone: '0555', email: 'a@x.test' });
    const failed = identityReducer(checking, { type: 'failure', seq: 1 });
    expect(failed.status).toBe('error');
    // An answer lands only on a running check: not on error, not on idle.
    expect(identityReducer(failed, { type: 'result', seq: 1, status: 'ok' }).status).toBe('error');
    expect(identityReducer(base, { type: 'result', seq: 0, status: 'ok' }).status).toBe('idle');
  });
});
