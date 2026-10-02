import type { CompanySettings } from '../../lib/api';

/**
 * What a company-settings save changes (ADMIN-DESTRUCTIVE-CONFIRMATION-001
 * Paket B) — one function for the save button, which asks when it finds a
 * change, and for `saveCompanySettingsAction`, which demands the
 * `company-settings.update` proof when it finds one against the settings it
 * has just read from the API. A save that changes nothing asks nothing.
 *
 * Compared the way the API stores them (`SaveCompanySettingsDto`): trimmed,
 * the support address lower-cased, an empty postal address as none.
 */

export type CompanySettingsValues = Pick<CompanySettings, 'legalName' | 'supportEmail' | 'postalAddress'>;

export type CompanySettingsChange = {
  key: 'legalName' | 'supportEmail' | 'postalAddress';
  label: string;
  from: string | null;
  to: string | null;
};

const LABELS: Record<CompanySettingsChange['key'], string> = {
  legalName: 'Yasal unvan',
  supportEmail: 'Destek e-postası',
  postalAddress: 'Posta adresi',
};

function normalize(values: CompanySettingsValues): Record<CompanySettingsChange['key'], string | null> {
  const trimmed = (value: string | null) => {
    const text = (value ?? '').trim();
    return text.length > 0 ? text : null;
  };
  return {
    legalName: trimmed(values.legalName),
    supportEmail: trimmed(values.supportEmail)?.toLowerCase() ?? null,
    postalAddress: trimmed(values.postalAddress),
  };
}

export function companySettingsChanges(stored: CompanySettingsValues, next: CompanySettingsValues): CompanySettingsChange[] {
  const before = normalize(stored);
  const after = normalize(next);
  return (Object.keys(LABELS) as Array<CompanySettingsChange['key']>)
    .filter((key) => before[key] !== after[key])
    .map((key) => ({ key, label: LABELS[key], from: before[key], to: after[key] }));
}

export function readCompanySettingsForm(data: FormData): CompanySettingsValues {
  const text = (name: string) => {
    const value = data.get(name);
    return typeof value === 'string' ? value : '';
  };
  return { legalName: text('legalName'), supportEmail: text('supportEmail'), postalAddress: text('postalAddress') };
}
