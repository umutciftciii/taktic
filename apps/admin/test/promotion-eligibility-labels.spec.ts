import { describe, expect, it } from 'vitest';
import { adminPermissionLabel } from '../lib/api';
import {
  describeBusinessRegistration,
  eligibilitySignalDetails,
  eligibilitySignalLabel,
} from '../lib/business-registration';
import { filterNavGroups, navGroups } from '../lib/nav';

/** CMP-006 PR-C — the operator's words for registrations and the eligibility queue. */
describe('business registration and eligibility labels', () => {
  it('names the two new permissions readably', () => {
    expect(adminPermissionLabel('PROVIDER_REGISTRATION_READ_SENSITIVE').area).toBe('Hizmet verenler');
    expect(adminPermissionLabel('PROVIDER_REGISTRATION_READ_SENSITIVE').action).toMatch(/ham değer/);
    expect(adminPermissionLabel('PROMOTION_ELIGIBILITY_REVIEW')).toEqual({
      area: 'Kampanya',
      action: 'promosyon uygunluk incelemesi ve kararı',
    });
  });

  it('puts the queue behind its own permission, not CAMPAIGNS_READ', () => {
    const only = (permission: string) =>
      filterNavGroups(navGroups, (candidate) => candidate === permission, false)
        .flatMap((group) => group.items)
        .map((item) => item.href);
    expect(only('PROMOTION_ELIGIBILITY_REVIEW')).toContain('/promotion-eligibility');
    expect(only('CAMPAIGNS_READ')).not.toContain('/promotion-eligibility');
  });

  it('describes a registration masked, and a legacy record honestly', () => {
    expect(describeBusinessRegistration({ status: 'DECLARED', type: 'TAX_NUMBER', numberMasked: '********90', updatedAt: null })).toBe(
      'Vergi kimlik numarası · ********90',
    );
    expect(describeBusinessRegistration(undefined)).toBe('Belirsiz / eski kayıt');
  });

  it('labels every gate code and prints only counts, ids and fingerprint counts', () => {
    for (const code of [
      'REGISTRATION_UNSPECIFIED',
      'REGISTRATION_NONE_DECLARED',
      'REGISTRATION_PROMOTION_CONSUMED',
      'REGISTRATION_SHARED',
      'PRIOR_PACKAGE_REFUND',
      'SHARED_IP',
      'HUMAN_DECISION',
    ]) {
      expect(eligibilitySignalLabel(code)).not.toBe(code);
    }
    expect(
      eligibilitySignalDetails({ code: 'SHARED_IP', otherProviderIds: ['p2'], ipFingerprints: ['v1:abc', 'v1:def'] }),
    ).toEqual(['Diğer hesap(lar): p2', '2 adres parmak izi (ham adres saklanmaz)']);
  });
});
