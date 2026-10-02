import { describe, expect, it } from 'vitest';
import {
  OFFER_STATUS_ERROR_MESSAGES,
  offerStatusErrorKey,
  offerStatusErrorMessage,
  REQUEST_STATUS_ERROR_MESSAGES,
  requestModerationErrorKey,
  requestStatusErrorMessage,
} from '../lib/status-conflicts';

/**
 * The 409s PR #119 and #120 added (and the older ones beside them) land on
 * the request and offer screens as a sentence, not the error boundary. These
 * pin which code picks which sentence, and that an unknown `?statusError=`
 * draws nothing.
 */
describe('offer status conflicts', () => {
  it('maps each coded refusal to its own sentence', () => {
    expect(offerStatusErrorKey('OFFER_ACTION_NOT_ALLOWED')).toBe('decided');
    expect(offerStatusErrorKey('CONTACT_DISCLOSURE_REQUIRED')).toBe('disclosureRequired');
    expect(offerStatusErrorKey('OFFER_ACCEPT_INSUFFICIENT_CREDIT')).toBe('insufficientCredit');
  });

  it('treats a bare or unknown 409 as a stale screen', () => {
    expect(offerStatusErrorKey(null)).toBe('stale');
    expect(offerStatusErrorKey('CONTACT_REVEAL_ALREADY_EXISTS')).toBe('stale');
  });

  it('draws a message only for a known key', () => {
    for (const key of Object.keys(OFFER_STATUS_ERROR_MESSAGES)) {
      expect(offerStatusErrorMessage(key)).toMatch(/değiştirilmedi|kabul edilmedi|İşlem yapılmadı/);
    }
    expect(offerStatusErrorMessage(undefined)).toBeNull();
    expect(offerStatusErrorMessage('toString')).toBeNull();
    expect(offerStatusErrorMessage('<script>')).toBeNull();
  });
});

describe('request status conflicts', () => {
  it.each([
    ['PHONE_NOT_VERIFIED', 'phoneNotVerified'],
    ['REQUEST_NOT_REMOVABLE', 'notRemovable'],
    ['REQUEST_STATUS_TRANSITION_NOT_ALLOWED', 'transitionNotAllowed'],
    ['REQUEST_STATUS_NOT_MODERATION_TARGET', 'notModerationTarget'],
    ['REQUEST_STATUS_CHANGED', 'statusChanged'],
  ])('maps the moderation refusal %s to %s', (code, key) => {
    expect(requestModerationErrorKey(code)).toBe(key);
  });

  it('leaves a bare or unknown moderation 409 to surface as an error', () => {
    expect(requestModerationErrorKey(null)).toBeNull();
    expect(requestModerationErrorKey('SOMETHING_NEW')).toBeNull();
  });

  it('has a sentence for every key, including the lifecycle refusals', () => {
    for (const key of ['notCancellable', 'notCompletable', ...Object.keys(REQUEST_STATUS_ERROR_MESSAGES)]) {
      expect(requestStatusErrorMessage(key)).toBeTruthy();
    }
    expect(requestStatusErrorMessage('constructor')).toBeNull();
    expect(requestStatusErrorMessage(undefined)).toBeNull();
  });

  it('no longer claims a cancel is possible in every state', () => {
    for (const message of Object.values(REQUEST_STATUS_ERROR_MESSAGES)) {
      expect(message).not.toContain('her durumda');
    }
  });

  // A refused rejection or a non-moderation status used to send the operator
  // to "İptal et". A closed request cannot be cancelled, and a matched one's
  // cancel leaves K2–K5 open; no refusal may offer it as the way out.
  it.each(Object.keys(REQUEST_STATUS_ERROR_MESSAGES))('%s does not steer the operator to "İptal et"', (key) => {
    const message = requestStatusErrorMessage(key) ?? '';
    expect(message).not.toMatch(/İptal et/);
    expect(message).not.toMatch(/iptal edilebilir|iptal için|kapatmak için/i);
  });
});
