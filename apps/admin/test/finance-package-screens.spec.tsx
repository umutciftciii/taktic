import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RefundActions, type RefundFormActions } from '../app/package-refunds/[id]/refund-actions';
import { PurchaseStatusConsequence } from '../app/package-purchases/[id]/purchase-status-consequence';
import { FinanceMonthBars } from '../components/finance-month-bars';
import { BalanceChange, SignedCredits } from '../components/ledger-cells';
import {
  formatLedgerSource,
  formatShortLira,
  formatSignedCount,
  gateLedgerSource,
} from '../lib/finance-format';
import type { PackageRefundDetail } from '../lib/api';

/**
 * ADMIN-DESIGN-001 Faz 3D — the pieces of the finance, package and refund
 * screens that decide something on their own: which refund controls are drawn
 * (only `allowedActions`), what the dialogs promise, and how credit and lira
 * figures are written.
 */

const noop = () => undefined;
const FORM_ACTIONS: RefundFormActions = { take: noop, approve: noop, reject: noop, markSettlementFailed: noop };

type Allowed = PackageRefundDetail['allowedActions'];
const NONE: Allowed = {
  take: false,
  approveNormal: false,
  approveException: false,
  reject: false,
  markSettlementFailed: false,
};

function renderActions(allowed: Partial<Allowed>): string {
  return renderToStaticMarkup(
    <RefundActions
      refundId="r1"
      allowedActions={{ ...NONE, ...allowed }}
      priceLabel="₺299,00"
      formActions={FORM_ACTIONS}
    />,
  );
}

const CONTROL_TEST_IDS: Record<keyof Allowed, string> = {
  take: 'package-refund-take',
  approveNormal: 'package-refund-approve-normal',
  approveException: 'package-refund-approve-exception',
  reject: 'package-refund-reject',
  markSettlementFailed: 'package-refund-mark-failed',
};

describe('refund controls come from allowedActions alone', () => {
  it('draws nothing when the API allows nothing', () => {
    const html = renderActions({});
    for (const testId of Object.values(CONTROL_TEST_IDS)) {
      expect(html).not.toContain(`data-testid="${testId}"`);
    }
  });

  it('draws exactly the one control each flag allows, and no other', () => {
    for (const [flag, testId] of Object.entries(CONTROL_TEST_IDS) as [keyof Allowed, string][]) {
      const html = renderActions({ [flag]: true });
      expect(html, flag).toContain(`data-testid="${testId}"`);
      for (const other of Object.values(CONTROL_TEST_IDS)) {
        if (other !== testId) expect(html, `${flag} → ${other}`).not.toContain(`data-testid="${other}"`);
      }
    }
  });

  it('never offers to mark a refund completed — SETTLED is the webhook’s alone', () => {
    const html = renderActions({
      take: true,
      approveNormal: true,
      approveException: true,
      reject: true,
      markSettlementFailed: true,
    });
    expect(html).not.toMatch(/iade tamamlandı olarak|tamamlandı olarak işaretle|SETTLED/);
  });

  it('asks before every decision, and before taking a request into review (Paket A)', () => {
    // A ConfirmDialog trigger opens a dialog: aria-haspopup on the button.
    const decisions = ['take', 'approveNormal', 'approveException', 'reject', 'markSettlementFailed'] as const;
    for (const flag of decisions) {
      const html = renderActions({ [flag]: true });
      expect(html, flag).toContain('aria-haspopup="dialog"');
      expect(html, flag).toContain('<dialog');
    }
    const take = renderActions({ take: true });
    expect(take).toContain('İade isteği işleme alınsın mı?');
    expect(take).toContain('e-posta gider');
    expect(take).toContain('Para ya da kredi hareket etmez.');
  });

  it('keeps the fields the API reads, with the same names', () => {
    const exception = renderActions({ approveException: true });
    expect(exception).toContain('name="kind" value="EXCEPTION"');
    expect(exception).toContain('name="exceptionGround"');
    expect(exception).toContain('name="exceptionReason"');
    expect(renderActions({ approveNormal: true })).toContain('name="kind" value="NORMAL"');
    expect(renderActions({ reject: true })).toContain('name="reason"');
    expect(renderActions({ markSettlementFailed: true })).toContain('name="reason"');
  });

  it('says that approving moves no money in TakTic and names the full amount to refund', () => {
    const html = renderActions({ approveNormal: true });
    expect(html).toContain('para ya da kredi hareket etmez');
    expect(html).toContain('tam tutar (₺299,00)');
    expect(html).toContain('imzalı iade bildirimi');
    expect(html).toContain('Onay geri alınamaz');
  });

  it('states the maker ≠ checker rule on both approval dialogs without deciding it', () => {
    for (const flag of ['approveNormal', 'approveException'] as const) {
      expect(renderActions({ [flag]: true }), flag).toContain('İsteği açan ya da işleme alan kişi onay veremez');
    }
  });

  it('labels every decision by its outcome, never "Kaydet" or "Tamam"', () => {
    const html = renderActions({
      approveNormal: true,
      approveException: true,
      reject: true,
      markSettlementFailed: true,
    });
    expect(html).not.toMatch(/>(Kaydet|Tamam|Onayla)</);
  });
});

describe('manual purchase correction dialog', () => {
  const text = (status: 'CANCELLED' | 'EXPIRED', kind?: 'OFFER_PACKAGE' | 'SHOWCASE_PACKAGE') =>
    renderToStaticMarkup(<PurchaseStatusConsequence status={status} kind={kind} />);

  it('promises no money or credit movement and no way back', () => {
    for (const status of ['CANCELLED', 'EXPIRED'] as const) {
      const html = text(status, 'OFFER_PACKAGE');
      expect(html).toContain('Para ve kredi hareket etmez');
      expect(html).toContain('bir daha “Bekliyor”a dönmez');
      expect(html).toContain('kredi yüklemez');
    }
  });

  it('mails the provider only for a cancelled vitrin purchase', () => {
    expect(text('CANCELLED', 'SHOWCASE_PACKAGE')).toContain('e-posta gider');
    expect(text('CANCELLED', 'OFFER_PACKAGE')).toContain('Hizmet verene e-posta gitmez');
    expect(text('EXPIRED', 'SHOWCASE_PACKAGE')).toContain('Hizmet verene e-posta gitmez');
  });
});

describe('credit and lira figures', () => {
  it('signs and groups whole credits', () => {
    expect(formatSignedCount(500)).toBe('+500');
    expect(formatSignedCount(1500)).toBe('+1.500');
    expect(formatSignedCount(-10)).toBe('-10');
    expect(formatSignedCount(0)).toBe('0');
    expect(formatSignedCount(2147483647)).toBe('+2.147.483.647');
  });

  it('shortens a lira amount on the integer kuruş, never producing fractions', () => {
    expect(formatShortLira(18_430_000)).toBe('184 B ₺');
    expect(formatShortLira(18_450_000)).toBe('185 B ₺');
    expect(formatShortLira(90_000)).toBe('900 ₺');
    expect(formatShortLira(0)).toBe('0 ₺');
  });

  it('draws the ledger amount with its sign and the balances as recorded', () => {
    expect(renderToStaticMarkup(<SignedCredits amount={-3} />)).toContain('is-out');
    expect(renderToStaticMarkup(<SignedCredits amount={25} />)).toContain('+25');
    const change = renderToStaticMarkup(<BalanceChange before={1200} after={1225} />);
    expect(change).toContain('1.200');
    expect(change).toContain('1.225');
  });

  it('links a related record only when this session may open it', () => {
    const campaign = formatLedgerSource('CampaignRedemption', 'x', null, { id: 'c1', name: 'Hoş geldin', versionNumber: 2 });
    expect(gateLedgerSource(campaign, () => false).href).toBeNull();
    expect(gateLedgerSource(campaign, (name) => name === 'CAMPAIGNS_READ').href).toBe('/campaigns/c1');
    const purchase = formatLedgerSource('PackagePurchase', 'p1', 'PS-1');
    expect(gateLedgerSource(purchase, (name) => name === 'PACKAGE_PURCHASES_READ').href).toBe('/package-purchases/p1');
    expect(gateLedgerSource(purchase, (name) => name === 'OFFERS_READ').href).toBeNull();
  });
});

describe('monthly revenue bars', () => {
  it('draws one item per month with its exact figure, the last one as current', () => {
    const html = renderToStaticMarkup(
      <FinanceMonthBars
        label="Aylık tahsilat"
        bars={[
          { key: '2026-08', label: 'Ağu', longLabel: 'Ağustos 2026', value: 0, shortValue: '0 ₺', fullValue: '₺0,00' },
          {
            key: '2026-09',
            label: 'Eyl',
            longLabel: 'Eylül 2026',
            value: 18_430_000,
            shortValue: '184 B ₺',
            fullValue: '₺184.300,00',
          },
        ]}
      />,
    );
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html).toContain('Eylül 2026: ₺184.300,00');
    expect(html).toContain('--bar-ratio:0.0000');
    expect(html).toContain('--bar-ratio:1.0000');
    expect(html).toMatch(/class="finance-month-bar is-current"[^>]*data-month="2026-09"/);
  });
});
