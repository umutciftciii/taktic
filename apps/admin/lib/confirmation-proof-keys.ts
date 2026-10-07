/**
 * The browser-safe half of the confirmation proof (see `confirmation-proof.ts`
 * for the design): the field name, the keys and the refusal sentence. No
 * crypto here, so `ConfirmDialog` — a client component — can import it.
 */

/** The form field the dialog adds, for one submission, after confirmation. */
export const CONFIRMATION_PROOF_FIELD = '__confirmationProof';

/** Long enough for a slow network between the click and the action; short enough to be useless later. */
export const CONFIRMATION_PROOF_TTL_MS = 2 * 60 * 1000;

/**
 * Every confirmation a proof can be minted for. One key per guarded action
 * (or per guarded branch of an action); `destructive-confirmation.spec`
 * holds every `ConfirmDialog` and every action check to this list.
 */
export const CONFIRMATION_PROOF_KEYS = [
  'campaign.close-draft',
  'campaign.end',
  'campaign.redemption-revoke',
  'campaign.version-activate',
  'campaign.version-switch',
  'campaign.version-resume',
  'campaign.pause',
  'campaign.resume',
  'campaign-engine.toggle',
  'category.create-published',
  'category.activate',
  'category.deactivate',
  'category.structure-update',
  'category.offer-credit-update',
  'category.unlimited-enable',
  'category.router-rules-update',
  'company-settings.update',
  'credit-package.create-active',
  'credit-package.update-commercial',
  'credit-package.activate',
  'credit-package.deactivate',
  'customer.status',
  'customer.activate',
  'customer.activation-link-reissue',
  'credits.grant',
  'credits.deduct',
  'offer.refund',
  'offer.accept',
  'offer.reject',
  'operations.auto-publish-enable',
  'operations.reviews-enable',
  'operations.reviews-disable',
  'operations.refund-window-update',
  'package-purchase.status',
  'package-refund.open',
  'package-refund.take',
  'package-refund.approve',
  'package-refund.reject',
  'package-refund.settlement-failed',
  'promotion-eligibility.decide',
  'provider-review.moderate',
  'provider-review.report-dismiss',
  'provider-invite.revoke',
  'provider.category-remove',
  'provider.status',
  'provider.approve',
  'provider.draft',
  'question.deactivate',
  'refund-scan.execute',
  'request.approve',
  'request.unpublish',
  'request.complete',
  'request.reopen',
  'request.report-dismiss',
  'request.cancel',
  'request.reject',
  'request.report-remove',
  'role.permissions',
  'role.status',
  'role.assign',
  'role.revoke',
  'scheduler.toggle',
  'seo.slug-change',
  'seo.redirect-deactivate',
  'seo.suggestion-approve',
  'seo.suggestion-reject',
  'scheduler.disable',
  'showcase.approve-first',
  'showcase.revision-approve',
  'showcase.placement-suspend',
  'showcase.reject',
  'showcase.placement-cancel',
  'showcase-package.create-active',
  'showcase-package.update-commercial',
  'showcase-package.activate',
  'showcase-package.deactivate',
  'support.status',
  'support.resolve',
  'user.status',
] as const;

export type ConfirmationProofKey = (typeof CONFIRMATION_PROOF_KEYS)[number];

export function isConfirmationProofKey(value: unknown): value is ConfirmationProofKey {
  return typeof value === 'string' && (CONFIRMATION_PROOF_KEYS as readonly string[]).includes(value);
}

/** The one sentence an action shows when it refuses a submission without a good proof. */
export const CONFIRMATION_PROOF_REFUSAL_MESSAGE =
  'İşlem yapılmadı: onay penceresinden onay alınamadı. Sayfa tam yüklendikten sonra yeniden deneyin.';
