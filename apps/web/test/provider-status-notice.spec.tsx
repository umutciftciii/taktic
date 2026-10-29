import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProviderStatusNotice } from '../app/providers/provider-status-notice';

/**
 * PROVIDER-STATUS-001: the provider's panel says what their account can do now
 * and where to ask — never why it was rejected or suspended.
 */

const html = (status: Parameters<typeof ProviderStatusNotice>[0]['status']) =>
  renderToStaticMarkup(<ProviderStatusNotice status={status} />);

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('ProviderStatusNotice', () => {
  it('REJECTED: neutral, with the support route, and no reason', () => {
    const said = html('REJECTED');
    expect(said).toContain('Başvurunuz şu aşamada onaylanmadı');
    expect(said).toContain('href="/destek"');
    expect(said).not.toMatch(/Sebep|gerekçe|reddedildi/i);
  });

  it('SUSPENDED: what stops, what continues, the support route, and no reason', () => {
    const said = html('SUSPENDED');
    expect(said).toContain('yeni iş almaya kapalı');
    expect(said).toContain('Kabul edilmiş işleriniz');
    expect(said).toContain('href="/destek"');
    expect(said).not.toMatch(/Sebep|gerekçe|ihlal|askıya alındı/i);
  });

  it('APPROVED and DRAFT: nothing', () => {
    expect(html('APPROVED')).toBe('');
    expect(html('DRAFT')).toBe('');
  });

  it('no provider screen reads a moderation field', () => {
    for (const path of ['app/providers/me/page.tsx', 'app/providers/[id]/page.tsx', 'lib/api.ts']) {
      const source = read(path);
      expect(source, path).not.toMatch(/\bprovider\.(rejectionReason|suspensionReason|moderationNote)\b/);
    }
    expect(read('lib/api.ts')).not.toMatch(/^\s+(rejectionReason|suspensionReason)\?: string/m);
  });
});

describe('customer offer detail: an unavailable offer', () => {
  it('turns 409 PROVIDER_UNAVAILABLE into one neutral sentence', () => {
    const source = read('app/requests/[id]/offers/[offerId]/page.tsx');
    expect(source).toContain("=== 'PROVIDER_UNAVAILABLE'");
    expect(source).toContain('Bu teklif şu anda kullanılamıyor.');
    expect(source).toContain('data-testid="offer-unavailable-notice"');
  });
});
