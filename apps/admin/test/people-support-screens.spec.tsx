import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_STATUSES,
  providerStatusConsequence,
} from '../app/providers/[id]/provider-status-consequence';
import { DetailHeader } from '../components/detail-header';
import type { ProviderStatus } from '../lib/api';

/**
 * ADMIN-DESIGN-001 Faz 3B — the pieces of the people and support screens that
 * decide something on their own: which provider status moves ask first and
 * what they say, and a detail header with no way back.
 */

function text(from: ProviderStatus, to: ProviderStatus): string | null {
  const node = providerStatusConsequence(from, to);
  return node === null ? null : renderToStaticMarkup(<>{node}</>);
}

describe('provider status confirmation', () => {
  it('asks before every move that stops a business working, and before no other', () => {
    const asked: string[] = [];
    for (const from of PROVIDER_STATUSES) {
      for (const to of PROVIDER_STATUSES) {
        if (text(from, to) !== null) asked.push(`${from}→${to}`);
      }
    }

    // Suspending and rejecting from anywhere, and taking an approved business
    // out of approval by any route. Approving, and moves between the
    // not-yet-approved states, go straight through.
    expect(asked.sort()).toEqual(
      [
        'APPROVED→DRAFT',
        'APPROVED→PENDING_REVIEW',
        'APPROVED→REJECTED',
        'APPROVED→SUSPENDED',
        'DRAFT→REJECTED',
        'DRAFT→SUSPENDED',
        'PENDING_REVIEW→REJECTED',
        'PENDING_REVIEW→SUSPENDED',
        'REJECTED→SUSPENDED',
        'SUSPENDED→REJECTED',
      ].sort(),
    );
    expect(text('APPROVED', 'APPROVED')).toBeNull();
  });

  it('says what suspension actually does: no requests, placements off air, claim links void, nothing deleted', () => {
    const said = text('APPROVED', 'SUSPENDED')!;
    expect(said).toContain('askıya alınır');
    expect(said).toContain('yeni talepleri göremez ve teklif veremez');
    expect(said).toContain('vitrin kartları hemen yayından kalkar');
    expect(said).toContain('claim');
    expect(said).toContain('silinmez');
    expect(said).toContain('e-posta gitmez');
  });

  it('only speaks of placements when the business is leaving approval', () => {
    expect(text('PENDING_REVIEW', 'REJECTED')).not.toContain('vitrin');
    expect(text('APPROVED', 'REJECTED')).toContain('vitrin');
  });

  it('does not promise void claim links for a move back to review, which keeps them', () => {
    expect(text('APPROVED', 'PENDING_REVIEW')).not.toContain('claim');
    expect(text('APPROVED', 'DRAFT')).toContain('claim');
  });
});

describe('DetailHeader without a way back', () => {
  it('draws no back link when the session may not open the list', () => {
    const html = renderToStaticMarkup(<DetailHeader back={null} title="Kayıt" />);
    expect(html).not.toContain('detail-back');
    expect(html).toContain('Kayıt');
  });
});
