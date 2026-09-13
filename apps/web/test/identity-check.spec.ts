import { describe, expect, it } from 'vitest';
import { identityReducer, type IdentityState } from '../app/request-fields/identity-check';

const base: IdentityState = { status: 'idle', seq: 0, phone: '', email: '' };

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
    const ok = identityReducer(identityReducer(base, { type: 'start', phone: '0555', email: 'a@x.test' }), { type: 'result', seq: 1, status: 'ok' });
    expect(identityReducer(ok, { type: 'fields', phone: '0556', email: 'a@x.test' }).status).toBe('idle');
    expect(identityReducer(ok, { type: 'fields', phone: '0555', email: 'a@x.test' }).status).toBe('ok');
  });

  it('turns a failed call into error, never ok', () => {
    const checking = identityReducer(base, { type: 'start', phone: '0555', email: 'a@x.test' });
    expect(identityReducer(checking, { type: 'failure', seq: 1 }).status).toBe('error');
  });
});
