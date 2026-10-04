import { assertSessionPolicyConfig } from './modules/auth/auth.constants';
import { assertContactSharingConfig } from './modules/contact-sharing/contact-sharing.config';
import { assertEmailBrandingConfig } from './modules/notifications/email-branding.config';
import { assertEmailTransportConfig } from './modules/notifications/email-transport';
import { assertPaymentProviderConfig } from './modules/payments/payment-provider.config';
import { assertPhoneVerificationTestBypassConfig } from './modules/phone-verification/phone-verification-test-bypass.config';
import { assertProviderClaimConfig } from './modules/provider-claim/provider-claim.config';
import { assertTurnstileConfig } from './modules/turnstile/turnstile.config';
import { assertPromotionFingerprintConfig } from './modules/business-registration/promotion-fingerprint';

/**
 * Every configuration check the API makes before it is allowed to start, in
 * the order it makes them.
 *
 * One list, read by two callers: main.ts runs it at boot and stops on the
 * first failure, and boot-config-check.ts runs it inside the image a deploy is
 * about to start — with the environment docker-compose.prod.yml will give that
 * container — so a configuration the new build would refuse is found by the
 * deploy preflight, before the API is stopped and before any migration is
 * applied, rather than by the new API failing to come up afterwards.
 *
 * Each check reads only the process environment. None opens a connection,
 * reads the database or contacts a provider, which is what makes the second
 * caller safe to run beside a live stack.
 */
export const BOOT_CONFIG_CHECKS: ReadonlyArray<{ name: string; assert: () => void }> = [
  // The public base URL is deliberately NOT checked here.
  //
  // It used to be, and the blast radius was wrong: a base URL that is unusable
  // in an e-mail took down authentication, the admin panel and every request
  // and offer flow with it. Whether a link can be clicked by a stranger is a
  // question about one message, so it is asked once per send by the delivering
  // transport, which refuses that message and records it as FAILED. See
  // common/public-urls.ts.

  // The company footer is no longer a boot condition. Its three values — legal
  // name, support address, postal address — are business facts an operator
  // maintains from the admin panel (CompanySettings), so a missing one must not
  // take a marketplace offline: the delivering transport refuses that one
  // message with EMAIL_BRANDING_INCOMPLETE instead, and the admin screen says
  // what is missing. This call only rejects a *deprecated* SUPPORT_EMAIL that
  // is set to something which is not an address at all.
  { name: 'email-branding', assert: assertEmailBrandingConfig },

  // The session policy, before anything can sign in. A duration that is not a
  // positive whole number of seconds is a security decision made by accident —
  // a typo reading as zero would end every session on the next request — so it
  // stops the process rather than silently restoring a default nobody chose.
  { name: 'session-policy', assert: assertSessionPolicyConfig },

  // Before anything listens. Turning contact sharing on without a disclosure
  // URL and version must stop the process rather than degrade into a state
  // where customers are asked to confirm having read nothing.
  { name: 'contact-sharing', assert: assertContactSharingConfig },

  // The outbound transport, before the first message is ever composed. A
  // production process wired to the console adapter would log "not delivered"
  // for every activation link while looking perfectly healthy, and one wired to
  // Resend without a key would discover that on the first send — as a FAILED
  // audit row nobody is watching at the time.
  { name: 'email-transport', assert: assertEmailTransportConfig },

  // Same reasoning, one flag over. A production process that offers to mail
  // claim links while nothing can actually deliver e-mail would hand out
  // ownership invitations no applicant ever receives, so it must not start.
  { name: 'provider-claim', assert: assertProviderClaimConfig },

  // The payment provider, before a single checkout can be opened. An
  // unrecognised PAYMENT_PROVIDER, a sandbox provider on a production
  // deployment, or any environment variable that could only mean "start taking
  // real money" all stop the process here rather than surfacing as a purchase
  // that loaded credits nobody paid for.
  { name: 'payment-provider', assert: assertPaymentProviderConfig },

  // The phone-verification test bypass, before a single code can be checked.
  // A flag that says "test mode" on a deployment that is not local or staging
  // stops the process here — with the variable's name and never its value —
  // rather than being silently ignored where somebody might rely on it.
  { name: 'phone-verification-test-bypass', assert: assertPhoneVerificationTestBypassConfig },

  // The Turnstile verifier, before a single request form can be posted. An
  // unset TURNSTILE_MODE means Cloudflare, and Cloudflare without its secret
  // and hostnames stops the process here rather than running every customer
  // write unprotected; a bypass mode outside NODE_ENV=test or a declared local
  // stack stops it just the same. The message names variables, never values.
  { name: 'turnstile', assert: assertTurnstileConfig },

  { name: 'promotion-fingerprint', assert: assertPromotionFingerprintConfig },
];

/** main.ts: every check, in order, stopping the process on the first refusal. */
export function assertBootConfig(): void {
  for (const check of BOOT_CONFIG_CHECKS) {
    check.assert();
  }
}

export type BootConfigCheckResult = { name: string; ok: true } | { name: string; ok: false; message: string };

/**
 * Every check, none skipped because an earlier one failed, so an operator sees
 * the whole list in one run. The messages are the checks' own boot messages,
 * which name variables and never print a secret.
 */
export function runBootConfigChecks(): BootConfigCheckResult[] {
  return BOOT_CONFIG_CHECKS.map(({ name, assert }) => {
    try {
      assert();
      return { name, ok: true };
    } catch (error) {
      return { name, ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
}
