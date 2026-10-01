import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CustomerActivateConsequence } from '../app/customers/[id]/customer-activate-consequence';
import {
  PROVIDER_STATUSES,
  providerApproveConsequence,
  providerDraftConsequence,
  providerStatusConsequence,
} from '../app/providers/[id]/provider-status-consequence';
import { ProviderStatusForm } from '../app/providers/[id]/provider-status-form';
import { providerStatusProofKey } from '../app/providers/[id]/provider-status-proof';
import {
  reportDismissConsequence,
  requestApproveConsequence,
  requestCompleteConsequence,
  requestReopenConsequence,
  requestUnpublishConsequence,
} from '../app/requests/[id]/request-lifecycle-consequence';
import type { ProviderStatus } from '../lib/api';

/**
 * ADMIN-DESTRUCTIVE-CONFIRMATION-001 — Faz 2: customer, provider and request
 * lifecycle confirmations.
 *
 * Pinned here: which moves ask (and which stay direct), that each dialog
 * names its own proof key, and that what each dialog says matches what the
 * API does from the state the record is in. The server side of the same
 * rules — a submission without the proof writes nothing — is in
 * `confirmation-proof.spec.ts`.
 */

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');
const noop = () => undefined;

describe('customer: Hesabı etkinleştir', () => {
  it('says they can sign in again, may send new requests, and the history stays', () => {
    const said = html(<CustomerActivateConsequence hasPassword />);
    expect(said).toContain('Müşteri yeniden giriş yapabilir.');
    expect(said).toContain('Aynı telefon ve e-postayla yeniden yeni talep verebilir');
    expect(said).toContain('geçmiş değişmez');
    expect(said).not.toContain('gerekçe');
  });

  it('does not promise a sign-in to an account with no password yet', () => {
    const said = html(<CustomerActivateConsequence hasPassword={false} />);
    expect(said).not.toContain('Müşteri yeniden giriş yapabilir.');
    expect(said).toContain('henüz şifre belirlemediği için');
  });

  it('the page asks before activating with its own key, and keeps the passivation dialog', () => {
    const source = read('app/customers/[id]/page.tsx');
    expect(source).toMatch(/<ConfirmDialog\s+proof="customer.activate"\s+triggerLabel="Hesabı etkinleştir"/);
    expect(source).toContain('testId="customer-activate"');
    expect(source).toMatch(/<ConfirmDialog\s+proof="customer.status"\s+triggerLabel="Hesabı pasife al"/);
    expect(source).not.toContain('data-testid="customer-activate"');
  });
});

describe('customer: Yeni bağlantı oluştur', () => {
  it('the first link is a plain button; only a reissue is a confirmation that posts replaces=1', () => {
    const source = read('app/customers/[id]/activation-link-form.tsx');
    expect(source).toContain('Şifre belirleme bağlantısı oluştur');
    expect(source).toMatch(
      /<input type="hidden" name="replaces" value="1" \/>\s*<ConfirmDialog\s+proof="customer.activation-link-reissue"\s+triggerLabel="Yeni bağlantı oluştur"/,
    );
    expect(source).toContain("const reissue = issued || (state.kind === 'error' && state.reissue === true);");
  });

  it('says the unused link stops working at once', async () => {
    const { ACTIVATION_LINK_REISSUE_CONSEQUENCE } = await import('../app/customers/[id]/activation-link-form');
    const said = html(ACTIVATION_LINK_REISSUE_CONSEQUENCE);
    expect(said).toContain('henüz kullanılmamış şifre belirleme bağlantısı hemen geçersiz olur');
    expect(said).toContain('72 saat');
  });
});

describe('provider: which moves ask, and with which key', () => {
  const all = PROVIDER_STATUSES as ProviderStatus[];

  it('the full matrix', () => {
    const matrix = Object.fromEntries(
      all.flatMap((from) => all.map((to) => [`${from}→${to}`, providerStatusProofKey(from, to)])),
    );
    expect(matrix).toEqual({
      'DRAFT→DRAFT': null,
      'DRAFT→PENDING_REVIEW': null,
      'DRAFT→APPROVED': 'provider.approve',
      'DRAFT→REJECTED': 'provider.status',
      'DRAFT→SUSPENDED': 'provider.status',
      'PENDING_REVIEW→DRAFT': 'provider.draft',
      'PENDING_REVIEW→PENDING_REVIEW': null,
      'PENDING_REVIEW→APPROVED': 'provider.approve',
      'PENDING_REVIEW→REJECTED': 'provider.status',
      'PENDING_REVIEW→SUSPENDED': 'provider.status',
      'APPROVED→DRAFT': 'provider.status',
      'APPROVED→PENDING_REVIEW': 'provider.status',
      'APPROVED→APPROVED': null,
      'APPROVED→REJECTED': 'provider.status',
      'APPROVED→SUSPENDED': 'provider.status',
      'REJECTED→DRAFT': 'provider.draft',
      'REJECTED→PENDING_REVIEW': null,
      'REJECTED→APPROVED': 'provider.approve',
      'REJECTED→REJECTED': null,
      'REJECTED→SUSPENDED': 'provider.status',
      'SUSPENDED→DRAFT': 'provider.draft',
      'SUSPENDED→PENDING_REVIEW': null,
      'SUSPENDED→APPROVED': 'provider.approve',
      'SUSPENDED→REJECTED': 'provider.status',
      'SUSPENDED→SUSPENDED': null,
    });
  });

  it('the Faz 1 key covers exactly the moves its text was written for', () => {
    for (const from of all) {
      for (const to of all) {
        expect(providerStatusProofKey(from, to) === 'provider.status', `${from}→${to}`).toBe(
          providerStatusConsequence(from, to) !== null,
        );
      }
    }
  });

  it('the action judges the stored status with the same function', () => {
    const source = read('app/providers/actions.ts');
    expect(source).toContain('return providerStatusProofKey(from, to);');
    expect(source).toContain('if (proofKey && !(await hasConfirmationProof(formData, proofKey))) {');
  });
});

describe('provider: what approving says, by the state it leaves', () => {
  const common = (said: string) => {
    expect(said).toContain('yayındaki talepleri görebilir ve kredisiyle teklif verebilir');
    expect(said).toContain('askıya alınmış vitrin yayınları varsa yeniden yayına girer');
    expect(said).toContain('onaylandığını bildiren e-posta gider');
    expect(said).toContain('Kampanya motoru açıksa');
    expect(said).toContain('kampanya ödülünü');
  };

  it('PENDING_REVIEW: an application is approved', () => {
    const said = html(providerApproveConsequence('PENDING_REVIEW'));
    common(said);
    expect(said).toContain('İncelemedeki başvuru onaylanır');
  });

  it('DRAFT: the review step is skipped', () => {
    const said = html(providerApproveConsequence('DRAFT'));
    common(said);
    expect(said).toContain('inceleme adımı atlanarak doğrudan onaylanır');
  });

  it('REJECTED: the stored reason goes', () => {
    const said = html(providerApproveConsequence('REJECTED'));
    common(said);
    expect(said).toContain('Reddedilmiş başvuru onaylanır; kayıtlı ret gerekçesi silinir.');
  });

  it('SUSPENDED: back to work, and the mail goes again', () => {
    const said = html(providerApproveConsequence('SUSPENDED'));
    common(said);
    expect(said).toContain('Askıya alınmış işletme yeniden onaylı');
    expect(said).toContain('e-posta tekrar gider');
  });
});

describe('provider: what moving into DRAFT says', () => {
  it('always: the claim links stop working, no mail', () => {
    for (const from of ['PENDING_REVIEW', 'REJECTED', 'SUSPENDED'] as const) {
      const said = html(providerDraftConsequence(from));
      expect(said, from).toContain('Kullanılmamış sahiplenme (claim) davet bağlantıları geçersiz olur');
      expect(said, from).toContain('otomatik e-posta gitmez');
    }
  });

  it('only out of REJECTED: the rejection reason is cleared', () => {
    expect(html(providerDraftConsequence('REJECTED'))).toContain('ret gerekçesi silinir');
    expect(html(providerDraftConsequence('PENDING_REVIEW'))).not.toContain('ret gerekçesi');
    expect(html(providerDraftConsequence('SUSPENDED'))).not.toContain('ret gerekçesi');
  });
});

describe('provider: the screens draw the dialog with the key', () => {
  it('the status form draws a dialog per key, with literal keys', () => {
    const source = read('app/providers/[id]/provider-status-form.tsx');
    expect(source).toMatch(/proofKey === 'provider.status' \? \(\s*<ConfirmDialog\s+proof="provider.status"/);
    expect(source).toMatch(/proofKey === 'provider.approve' \? \(\s*<ConfirmDialog\s+proof="provider.approve"/);
    expect(source).toMatch(/proofKey === 'provider.draft' \? \(\s*<ConfirmDialog\s+proof="provider.draft"/);
  });

  it('opens on the current status: no dialog, the save shut', () => {
    const markup = html(
      <ProviderStatusForm providerId="p-1" status="PENDING_REVIEW" moderationNote={null} rejectionReason={null} action={noop} />,
    );
    expect(markup).toMatch(/<button type="submit"[^>]*disabled=""[^>]*data-testid="provider-status-save"/);
    expect(markup).not.toContain('aria-haspopup="dialog"');
  });

  it('the header approve/re-activate is a confirmation with the approval key', () => {
    const source = read('app/providers/[id]/page.tsx');
    expect(source).toMatch(/<ConfirmDialog\s+proof="provider.approve"\s+triggerLabel=\{reactivate \? 'Tekrar aktif et' : 'Onayla'\}/);
    expect(source).toContain('consequence={providerApproveConsequence(provider.status)}');
    expect(source).toContain('testId="provider-approve"');
    expect(source).not.toContain('data-testid="provider-approve"');
    // The suspension keeps its Faz 1 dialog.
    expect(source).toMatch(/<ConfirmDialog\s+proof="provider.status"\s+triggerLabel="İş almasını durdur"/);
  });
});

describe('request lifecycle: what each dialog says', () => {
  it('approve: published, the 14 days start, the customer and matching providers are told', () => {
    const said = html(requestApproveConsequence());
    expect(said).toContain('Talep yayına çıkar');
    expect(said).toContain('14 günlük yayın süresi onay anında başlar');
    expect(said).toContain('Müşteriye talebinin yayına çıktığı bildirimi gider');
    expect(said).toContain('eşleşen hizmet verenlere yeni talep bildirimi');
    // No made-up count: the panel has no read for it.
    expect(said).not.toMatch(/\d+ hizmet veren/);
  });

  it('unpublish: off the market for now, offers stay, the clock restarts on re-approval', () => {
    const said = html(requestUnpublishConsequence());
    expect(said).toContain('geçici olarak yayından kalkar');
    expect(said).toContain('Açık teklifler kapanmaz');
    expect(said).toContain('14 günlük yayın süresi baştan başlar');
    expect(said).toContain('yeniden yayın e-postası gidebilir');
  });

  it('complete: terminal, a review invitation, no way back', () => {
    const said = html(requestCompleteConsequence());
    expect(said).toContain('“Tamamlandı”');
    expect(said).toContain('değerlendirmesi için davet');
    expect(said).toContain('Bu bir kapanış durumudur');
    expect(said).toContain('geri alınamaz');
    expect(said).not.toContain('gerekçe');
  });

  it('reopen: republished, approvedAt refreshed, closed offers and refunds stay', () => {
    const said = html(requestReopenConsequence());
    expect(said).toContain('yeniden yayına çıkar');
    expect(said).toContain('Onay zamanı yenilenir: 14 günlük yayın süresi baştan başlar');
    expect(said).toContain('kapatılan teklifler geri açılmaz');
    expect(said).toContain('kredi iadeleri geri alınmaz');
    expect(said).toContain('Müşteriye talebinin yeniden yayına çıktığı bildirimi gider');
    expect(said).toContain('yeni talep bildirimi gidebilir');
  });

  it('dismiss: every open report closes, no reopen, nothing else moves', () => {
    expect(html(reportDismissConsequence(1))).toContain('Açık bildirim “Uygun bulundu” kararıyla kapanır');
    const said = html(reportDismissConsequence(3));
    expect(said).toContain('3 açık bildirimin hepsi');
    expect(said).toContain('yeniden açan bir işlem yok');
    expect(said).toContain('Talep, teklifler ve krediler olduğu gibi kalır');
  });
});

describe('request lifecycle: the screen asks on exactly the risky moves', () => {
  const source = read('app/requests/[id]/page.tsx');

  it('approve always, into review only out of APPROVED', () => {
    expect(source).toMatch(/: targetStatus === 'APPROVED'\s*\? 'approve'\s*: currentStatus === 'APPROVED'\s*\? 'unpublish'\s*: null;/);
    expect(source).toMatch(/<ConfirmDialog\s+proof="request.approve"/);
    expect(source).toMatch(/<ConfirmDialog\s+proof="request.unpublish"/);
  });

  it('complete only on a MATCHED request; reopen and dismiss always', () => {
    expect(source).toMatch(/\{request\.status === 'MATCHED' \? \(\s*<ConfirmDialog\s+proof="request.complete"/);
    expect(source).toMatch(/<ConfirmDialog\s+proof="request.reopen"\s+triggerLabel="Talebi geri aç"/);
    expect(source).toMatch(/<ConfirmDialog\s+proof="request.report-dismiss"\s+triggerLabel="Uygun bulundu"/);
    expect(source).toContain('consequence={reportDismissConsequence(openCount)}');
  });

  it('the action applies the same rule to IN_REVIEW, judged against the stored status', () => {
    const actions = read('app/requests/actions.ts');
    expect(actions).toContain(
      "return (await isPublished(id)) ? hasConfirmationProof(formData, 'request.unpublish') : true;",
    );
  });
});
