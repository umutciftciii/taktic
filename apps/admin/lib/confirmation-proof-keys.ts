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
  // MATCH-001: a service's delivery model, which decides who new requests reach.
  'category.delivery-model-update',
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
  // OBS-ALERT-002: operations-alert e-mail recipients and the routing switch.
  'ops-alert-recipient.pause',
  'ops-alert-recipient.delete',
  'ops-alert-recipient.replace',
  'ops-alert-recipient.reveal',
  'ops-alert-recipient.last-critical',
  'ops-alert-routing.cutover',
  'ops-alert-routing.revert',
  'ops-alert-routing.rewrap',
  'offer.refund',
  'offer.accept',
  'offer.reject',
  'operations.auto-publish-enable',
  'operations.reviews-enable',
  'operations.reviews-disable',
  // REL-002 Faz 3: the customer service-issue switch, each direction.
  'operations.service-issues-enable',
  'operations.service-issues-disable',
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
  // REL-002 Faz 5: staff open Round 4+ on a request in MATCH_REVIEW.
  'request.open-next-round',
  'request.report-dismiss',
  'request.cancel',
  'request.reject',
  'request.report-remove',
  'role.permissions',
  'role.status',
  'role.assign',
  'role.revoke',
  // REL-002 Faz 4: incident decisions, the super admin's correction, and the
  // provider reliability review workflow.
  'reliability-review.acknowledge',
  'reliability-review.resolve',
  'scheduler.toggle',
  'service-incident.adjudicate',
  'service-incident.correct',
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
  // SHOWCASE-ALLOWANCE-004: voiding what is left of a run's free offers.
  'showcase.allowance-void',
  'showcase-package.create-active',
  'showcase-package.update-commercial',
  'showcase-package.activate',
  'showcase-package.deactivate',
  'support.status',
  'support.resolve',
  'user.status',
] as const;

export type ConfirmationProofKey = (typeof CONFIRMATION_PROOF_KEYS)[number];

/** OBS-ALERT-002 — named so the screens and actions of the recipient panel share one spelling. */
export const OPS_ALERT_RECIPIENT_PAUSE = 'ops-alert-recipient.pause' satisfies ConfirmationProofKey;
export const OPS_ALERT_RECIPIENT_DELETE = 'ops-alert-recipient.delete' satisfies ConfirmationProofKey;
export const OPS_ALERT_RECIPIENT_REPLACE = 'ops-alert-recipient.replace' satisfies ConfirmationProofKey;
export const OPS_ALERT_RECIPIENT_REVEAL = 'ops-alert-recipient.reveal' satisfies ConfirmationProofKey;
export const OPS_ALERT_RECIPIENT_LAST_CRITICAL = 'ops-alert-recipient.last-critical' satisfies ConfirmationProofKey;
export const OPS_ALERT_ROUTING_CUTOVER = 'ops-alert-routing.cutover' satisfies ConfirmationProofKey;
export const OPS_ALERT_ROUTING_REVERT = 'ops-alert-routing.revert' satisfies ConfirmationProofKey;
export const OPS_ALERT_ROUTING_REWRAP = 'ops-alert-routing.rewrap' satisfies ConfirmationProofKey;

export function isConfirmationProofKey(value: unknown): value is ConfirmationProofKey {
  return typeof value === 'string' && (CONFIRMATION_PROOF_KEYS as readonly string[]).includes(value);
}

/** The one sentence an action shows when it refuses a submission without a good proof. */
export const CONFIRMATION_PROOF_REFUSAL_MESSAGE =
  'İşlem yapılmadı: onay penceresinden onay alınamadı. Sayfa tam yüklendikten sonra yeniden deneyin.';
