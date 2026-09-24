import catalog from '../../../packages/shared/business-registration.json';

/**
 * The canonical business registration and the promotion eligibility queue
 * (CMP-006 PR-C), as the admin panel words them. Client-safe — the raw-value
 * reveal and the decision form are Client Components. Types and labels come
 * from `packages/shared/business-registration.json`, the API's own file.
 */

export type BusinessRegistrationType = keyof typeof catalog.types;

export type BusinessRegistrationView = {
  status: 'DECLARED' | 'NONE_DECLARED' | 'UNSPECIFIED';
  type: BusinessRegistrationType | null;
  numberMasked: string | null;
  updatedAt: string | null;
};

export function businessRegistrationLabel(type: BusinessRegistrationType | null | undefined): string {
  return type ? catalog.types[type]?.label ?? type : '—';
}

export const BUSINESS_REGISTRATION_STATUS_LABELS: Record<BusinessRegistrationView['status'], string> = {
  DECLARED: 'Beyan edildi',
  NONE_DECLARED: 'Beyan edilmedi',
  UNSPECIFIED: 'Belirsiz / eski kayıt',
};

/** One line, masked: what a list cell or a card row shows. */
export function describeBusinessRegistration(view: BusinessRegistrationView | null | undefined): string {
  if (!view || view.status === 'UNSPECIFIED') return BUSINESS_REGISTRATION_STATUS_LABELS.UNSPECIFIED;
  if (view.status === 'NONE_DECLARED') return BUSINESS_REGISTRATION_STATUS_LABELS.NONE_DECLARED;
  return `${businessRegistrationLabel(view.type)} · ${view.numberMasked ?? ''}`;
}

/** The gate's closed signal codes, in the operator's words. */
export const ELIGIBILITY_SIGNAL_LABELS: Record<string, string> = {
  NO_ACCOUNT: 'Başvuruya bağlı hesap yok',
  PROVIDER_NOT_APPROVED: 'Profil onaylı değil',
  EMAIL_UNVERIFIED: 'E-posta doğrulanmamış',
  PHONE_UNVERIFIED: 'Telefon doğrulanmamış',
  REGISTRATION_UNSPECIFIED: 'İşletme kaydı yok (eski kayıt)',
  REGISTRATION_NONE_DECLARED: 'İşletme kaydı beyan edilmedi',
  REGISTRATION_PROMOTION_CONSUMED: 'Aynı işletme kaydıyla başka bir hesap promosyon almış',
  REGISTRATION_SHARED: 'Aynı işletme kaydı başka bir hesapta da kayıtlı',
  PRIOR_PACKAGE_REFUND: 'Daha önce paket iadesi / ödeme ters kaydı var',
  SHARED_IP: 'Başka bir hizmet veren hesabıyla ortak oturum adresi (tek başına engel değil)',
  HUMAN_DECISION: 'Yetkili kararı',
};

export function eligibilitySignalLabel(code: string): string {
  return ELIGIBILITY_SIGNAL_LABELS[code] ?? code;
}

export type EligibilitySignal = { code: string } & Record<string, unknown>;

export type PromotionEligibilityHoldView = {
  eventId: string;
  triggerEventKey: string;
  trigger: 'PROVIDER_APPROVED' | 'PROVIDER_ELIGIBILITY_REACHED' | 'PACKAGE_PAYMENT_SUCCEEDED';
  eventStatus: string;
  provider: { id: string; businessName: string; status: string };
  heldAt: string;
  snapshotVersion: number;
  snapshot: { outcome: string; signals: EligibilitySignal[] };
  review: {
    decision: 'ELIGIBLE' | 'INELIGIBLE';
    reason: string;
    decidedAt: string;
    decidedBy: { id: string; name: string | null; email: string | null };
  } | null;
  candidateCampaigns?: Array<{ id: string; key: string; name: string }>;
};

export const ELIGIBILITY_DECISION_LABELS: Record<'ELIGIBLE' | 'INELIGIBLE', string> = {
  ELIGIBLE: 'Uygun — promosyon değerlendirilsin',
  INELIGIBLE: 'Uygun değil — promosyon verilmesin',
};

export const ELIGIBILITY_TRIGGER_LABELS: Record<string, string> = {
  PROVIDER_APPROVED: 'Profil onayı',
  PROVIDER_ELIGIBILITY_REACHED: 'Doğrulama tamamlandı',
  PACKAGE_PAYMENT_SUCCEEDED: 'Paket ödemesi',
};

/** The details of a signal worth printing beside its label: counts and ids, nothing else is stored. */
export function eligibilitySignalDetails(signal: EligibilitySignal): string[] {
  const details: string[] = [];
  if (typeof signal.registrationType === 'string') {
    details.push(businessRegistrationLabel(signal.registrationType as BusinessRegistrationType));
  }
  if (Array.isArray(signal.otherProviderIds) && signal.otherProviderIds.length > 0) {
    details.push(`Diğer hesap(lar): ${signal.otherProviderIds.join(', ')}`);
  }
  for (const [key, label] of [
    ['settledRequests', 'tamamlanan iade isteği'],
    ['refundedPurchases', 'iade edilmiş satın alma'],
    ['paymentReversals', 'ödeme ters kaydı'],
  ] as const) {
    if (typeof signal[key] === 'number' && (signal[key] as number) > 0) details.push(`${signal[key]} ${label}`);
  }
  if (Array.isArray(signal.ipFingerprints) && signal.ipFingerprints.length > 0) {
    details.push(`${signal.ipFingerprints.length} adres parmak izi (ham adres saklanmaz)`);
  }
  return details;
}
