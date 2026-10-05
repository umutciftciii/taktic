import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import catalog from '../../../packages/shared/campaign-rules.json';
import { CampaignDefinitionForm } from '../app/campaigns/campaign-definition-form';
import { CreditOperationForm } from '../app/providers/[id]/credits/credit-operation-form';
import {
  ADMIN_DEDUCT_POLICY_OPTIONS,
  CREDIT_POLICY_GROUP_LABEL,
  CREDIT_POLICY_NOTE,
  SPEND_PRIORITY_OPTIONS,
  adminDeductPolicyLabel,
  benefitProducesCredit,
  buildDefinition,
  emptyForm,
  errorFieldOf,
  formFromDefinition,
  spendPriorityLabel,
} from '../lib/campaign-rules';

/**
 * CAMPAIGN-CREDIT-POLICY-001 — the panel's half: the builder always sends an
 * explicit schema v2 credit policy (default PROMO_FIRST + PAID_ONLY), reads it
 * back for a revision, points API errors at its two radio groups, and the
 * manual credit form judges a deduction against the deductible total.
 */

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

describe('credit policy in the campaign builder', () => {
  it('sends schema v2 with an explicit policy, defaulting to PROMO_FIRST + PAID_ONLY', () => {
    const definition = buildDefinition(emptyForm());
    expect(definition.schemaVersion).toBe(2);
    expect(catalog.schemaVersion).toBe(2);
    expect(definition.benefit.creditPolicy).toEqual({ spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'PAID_ONLY' });
  });

  it('sends whichever of the four combinations was chosen, and reads it back for a revision', () => {
    for (const spendPriority of ['PROMO_FIRST', 'PAID_FIRST'] as const) {
      for (const adminDeductPolicy of ['PAID_ONLY', 'ALLOW_PROMO'] as const) {
        const definition = buildDefinition({ ...emptyForm(), spendPriority, adminDeductPolicy });
        expect(definition.benefit.creditPolicy).toEqual({ spendPriority, adminDeductPolicy });
        expect(formFromDefinition(definition)).toMatchObject({ spendPriority, adminDeductPolicy });
      }
    }
  });

  it('offers exactly the catalogue’s values with the agreed labels', () => {
    expect(SPEND_PRIORITY_OPTIONS.map((option) => [option.value, option.label])).toEqual([
      ['PROMO_FIRST', 'Önce kampanya kredisi'],
      ['PAID_FIRST', 'Önce ücretli kredi'],
    ]);
    expect(ADMIN_DEDUCT_POLICY_OPTIONS.map((option) => [option.value, option.label])).toEqual([
      ['PAID_ONLY', 'Yalnız ücretli krediden'],
      ['ALLOW_PROMO', 'Kampanya kredisinden de kesilebilir'],
    ]);
    expect(CREDIT_POLICY_GROUP_LABEL).toBe('Kredi kullanım kuralları');
    expect(CREDIT_POLICY_NOTE).toBe(
      'Kurallar bu kampanya sürümünün parçasıdır. Değişiklik yeni sürüm gerektirir; önceden verilen krediler eski sürüm kurallarını korur.',
    );
    expect(spendPriorityLabel(null)).toBe('—');
    expect(adminDeductPolicyLabel('ALLOW_PROMO')).toBe('Kampanya kredisinden de kesilebilir');
  });

  it('only a credit-producing benefit carries a policy', () => {
    expect(benefitProducesCredit('PROMO_CREDITS')).toBe(true);
    expect(benefitProducesCredit('CHECKOUT_DISCOUNT')).toBe(false);
  });

  it('points the API’s policy errors at the two radio groups', () => {
    const form = emptyForm();
    expect(errorFieldOf('benefit.creditPolicy.spendPriority', form)).toEqual({ field: 'spendPriority' });
    expect(errorFieldOf('benefit.creditPolicy.adminDeductPolicy', form)).toEqual({ field: 'adminDeductPolicy' });
    expect(errorFieldOf('benefit.creditPolicy', form)).toEqual({ field: 'creditPolicy' });
  });

  it('renders the group with both axes, the note and the defaults checked', () => {
    const markup = html(<CampaignDefinitionForm mode="create" initialForm={emptyForm()} />);
    expect(markup).toContain('data-testid="campaign-credit-policy"');
    expect(markup).toContain('Kredi kullanım kuralları');
    expect(markup).toContain('Harcama önceliği');
    expect(markup).toContain('Yönetici kredi kesintisi');
    expect(markup).toContain(CREDIT_POLICY_NOTE);
    expect(markup).toMatch(/<input [^>]*data-testid="campaign-spend-priority-PROMO_FIRST"[^>]*checked=""[^>]*>/);
    expect(markup).toMatch(/<input [^>]*data-testid="campaign-admin-deduct-policy-PAID_ONLY"[^>]*checked=""[^>]*>/);
    expect(markup).not.toMatch(/<input [^>]*data-testid="campaign-spend-priority-PAID_FIRST"[^>]*checked=""[^>]*>/);
    expect(markup).not.toMatch(/<input [^>]*data-testid="campaign-admin-deduct-policy-ALLOW_PROMO"[^>]*checked=""[^>]*>/);
  });
});

describe('the manual deduction form judges the deductible total', () => {
  it('shows the deductible total on the deduct tab and carries an idempotency key field', () => {
    const markup = html(
      <CreditOperationForm providerId="p-1" businessName="Usta Klima" currentBalance={13} deductibleBalance={3} canGrant={false} canDeduct />,
    );
    expect(markup).toContain('data-testid="credit-operation-deductible"');
    expect(markup).toMatch(/data-testid="credit-operation-deductible">3</);
    expect(markup).toMatch(/<input type="hidden" [^>]*name="idempotencyKey" value=""\/>/);
    // No key before hydration: nothing can be sent without one.
    expect(markup).toMatch(/<button type="submit"[^>]*disabled=""[^>]*data-testid="credit-operation-deduct"/);
  });

  it('offers no deduction when the API could not split the wallet', () => {
    const markup = html(
      <CreditOperationForm providerId="p-1" businessName="Usta Klima" currentBalance={13} deductibleBalance={null} canGrant={false} canDeduct />,
    );
    expect(markup).toContain('data-testid="credit-operation-deduct-unavailable"');
  });
});
