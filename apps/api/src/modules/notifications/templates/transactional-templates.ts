import { unviewedOfferRefundNotice } from '../../offers/refund-policy';
import { EmailBranding } from '../email-branding.config';
import { NotificationMessage } from '../notification.port';
import {
  EmailBlock,
  EmailDataRow,
  EmailDocument,
  RenderedDocument,
  renderDocument,
} from './email-design';
import {
  formatCredits,
  formatDate,
  formatDateRange,
  formatDateTime,
  formatLocation,
  formatMoneyMinor,
  formatMoneyMinorIn,
  nonEmpty,
  truncate,
  urgencyLabel,
} from './format';

/**
 * The transactional messages, as data.
 *
 * Each entry turns the `data` bag the dispatcher carried into an
 * {@link EmailDocument}. The shape mirrors the design handoff one block at a
 * time; what differs from the handoff is where the handoff showed a value this
 * platform does not actually compute.
 *
 * The rule applied throughout: **a row exists only when there is a true value
 * for it.** `row()` returns null for an absent value and the row disappears, so
 * a missing phone number, an unset preferred date or a disabled contact-sharing
 * flag narrows the table instead of printing a placeholder. Nothing here has a
 * sample fallback.
 *
 * Removed from the handoff for want of a real source — every one of these is a
 * number the design invented and this system does not hold:
 *
 * - `device_summary` (01) — no session fingerprint is recorded for a reset.
 * - `application_no` (03) — provider applications carry no display number;
 *   NumberedEntityType covers requests, offers and purchases only.
 * - `welcome_credits` (04) — there is no welcome grant. Credits arrive by
 *   purchase or by an admin grant, and neither happens on approval.
 * - `provider_rating` (07) — replaced by the review summary, which only the
 *   public profile and offer cards render, never a mail.
 * - `provider_job_count` (07) — no such count is computed anywhere.
 * - `expected_offer_range` (06) — nothing forecasts offer volume.
 * - `acceptance_rate` (11) — no such metric is computed anywhere.
 * - `existing_offer_count` (09) — computable, but it would tell a provider how
 *   many rivals are already on a request, which the discovery screen
 *   deliberately does not disclose. Left out rather than widened here.
 * - `messages_url` (08) — there is no messaging feature; the call to action
 *   points at the request page the customer really has.
 *
 * Also softened: the handoff's service-level promises ("genellikle 1 iş günü
 * içinde", "ilk 24 saat içinde gelmeye başlar") and its performance claims
 * ("erken teklifler daha yüksek kabul oranına sahiptir") are assertions nothing
 * in the product measures or guarantees, so they are replaced with statements
 * that are true of the system as built.
 */

/**
 * Every template identifier: the twelve from the handoff, in its order, then
 * the four this system grew afterwards.
 *
 * The last four are not a second family. Three of them — the guest activation
 * link, the provider claim invitation and the day-7 request reminder — predate
 * the design system and used to render through a separate plain renderer in
 * email-template.ts; that renderer is gone, and they are documents here like
 * everything else. Their wording, their template variables, their links and
 * their expiry semantics are unchanged; only the shell around them is.
 *
 * The fourth, the credit-package receipt, was written against this system from
 * the start.
 */
export const TRANSACTIONAL_EMAIL_TEMPLATES = [
  'password-reset',
  'email-verification',
  'provider-application-received',
  'provider-application-approved',
  'request-received',
  'request-published',
  'offer-received',
  'match-customer',
  'request-available',
  'offer-accepted',
  'offer-not-selected',
  'credit-refunded',
  'customer-activation',
  'provider-claim',
  'request-expiring',
  // The two halves of one clock event: an approved request reached the end of
  // its fourteen days. Two templates rather than one parameterised by audience,
  // for the reason the support-ticket pairs are two — the customer is told what
  // happened to *their* request and how to open another, the provider is told
  // that a request they spent a credit on closed with no decision, and a
  // template that chose between those at render time would be one edit away
  // from putting a customer's contact row in a provider's inbox.
  'request-expired-customer',
  'request-expired-provider',
  'package-purchase-confirmation',
  // The support-ticket messages: five per desk. Two of each five go to the
  // operator inbox and three to the person who opened the ticket, and they are
  // deliberately separate templates rather than one parameterised by audience —
  // the pair a single event produces say different things to different people,
  // and a template that decided which of the two it was at render time would be
  // one edit away from telling the person waiting what only an operator may
  // read.
  //
  // The two desks are separate for a second reason on top of that one. A hizmet
  // alan's ticket is about a talep and a hizmet veren's is about teklifler,
  // krediler and their işletme profili, so the two are not the same sentence
  // with a different noun in it — and the hizmet veren's copies link into the
  // panel they actually use.
  'support-ticket-created',
  'support-ticket-new-for-support',
  'support-ticket-customer-reply',
  'support-ticket-admin-reply',
  'support-ticket-status-changed',
  'support-ticket-provider-created',
  'support-ticket-provider-new-for-support',
  'support-ticket-provider-reply',
  'support-ticket-provider-admin-reply',
  // The provider's mailbox proof (AUTH-PROVIDER-CONTACT-001). A separate
  // template from `email-verification` for the reason the support pairs are
  // separate: the customer's mail welcomes them to their first request, the
  // provider's points at the panel they already have, and a template that
  // chose between the two at render time would be one edit away from sending
  // a business the customer's copy.
  'provider-email-verification',
  'support-ticket-provider-status-changed',
  // Vitrin, phase two. Four messages, and each one belongs to exactly one
  // person for exactly one reason:
  //
  //  - the placement went live      → the provider who paid for it
  //  - a direct lead arrived        → the one business it was addressed to
  //  - the answer window closed     → the customer, who has a decision to make
  //  - the answer window closed     → the provider, who missed a promise
  //
  // The last two are the same event and are deliberately two templates rather
  // than one parameterised by audience. What the customer is told is "here is
  // your choice"; what the provider is told is "you missed this, here is the
  // record". A template that decided which of the two it was at render time
  // would be one edit away from putting the customer's fallback options in the
  // provider's inbox.
  'showcase-placement-activated',
  'showcase-lead-received',
  'showcase-lead-breached-customer',
  'showcase-lead-breached-provider',
  // Vitrin, phase three: the rest of a run's life, from the money to the end
  // of the clock. Every one of them goes to the provider who owns the card or
  // paid for the package, and nothing here is a customer message.
  //
  //  - the package was paid for            → what was bought, when the right lapses
  //  - the payment did not complete        → no card detail, a way back to the shop
  //  - approved and live in one transaction → one message, not two
  //  - approved with nothing on the air    → the approval alone
  //  - seven days, three days, and the end → three notices per run, each once
  //
  // "Approved and live" is deliberately one template rather than the approval
  // and `showcase-placement-activated` sent back to back: the two facts are
  // one transaction, and two messages about one event teach a provider to
  // ignore the second. `showcase-placement-activated` stays for the run that
  // goes up at a *different* moment from the approval — a right spent on a
  // card that was already approved.
  'showcase-package-payment-succeeded',
  'showcase-package-payment-failed',
  'showcase-card-approved-live',
  'showcase-card-approved',
  'showcase-placement-ending-7d',
  'showcase-placement-ending-3d',
  'showcase-placement-expired',
  // A request report, in two messages that must stay two. The customer whose
  // request was taken down is told a fixed reason and nothing else — not who
  // reported, not how many did, not what the operator wrote. The support
  // inbox is told that a report exists, which reason, and where to open it —
  // never the reporter's free text, which stays in the panel like a ticket
  // body does. A template that served both would be one edit away from
  // mailing a reporter's words to the person they reported.
  'request-removed',
  'request-report-new-for-support',
  // Reviews: four messages, each to exactly one audience; the comment text is
  // in none of them.
  //
  //  - the request was completed     → the customer, invited to rate the work
  //  - a review arrived              → the provider, told the star count only
  //  - the provider reported it      → the support inbox, without the note
  //  - an operator removed it        → the customer, with a fixed reason
  //
  // The comment is read on the public profile and in the panel, each behind
  // its own session; a mail that quoted it would put a customer's words in a
  // provider's inbox and a reporter's words next to the review they reported.
  'review-invitation',
  'review-received',
  'review-report-new-for-support',
  'review-removed',
] as const;

export type TransactionalEmailTemplate = (typeof TRANSACTIONAL_EMAIL_TEMPLATES)[number];

export function isTransactionalEmailTemplate(value: string): value is TransactionalEmailTemplate {
  return (TRANSACTIONAL_EMAIL_TEMPLATES as readonly string[]).includes(value);
}

/**
 * The salutation when the platform holds no name for the recipient.
 *
 * Every message opens with exactly one salutation, so there has to be
 * something; this is the least wrong thing to say, and templates that have a
 * better second source for the name — the business on a claim invitation, say —
 * check for this value and prefer theirs.
 */
const GENERIC_RECIPIENT = 'Kullanıcı';

type Data = Record<string, string | null | undefined>;

/**
 * The subject line, derived from the same data the body is.
 *
 * Exported because the dispatcher needs it before rendering — NotificationMessage
 * carries the subject as its own field — and deriving it in two places is how
 * the subject and the body come to disagree.
 */
export function transactionalSubject(
  template: TransactionalEmailTemplate,
  data: Data = {},
): string {
  switch (template) {
    case 'password-reset':
      return 'TakTick şifrenizi sıfırlayın';
    case 'email-verification':
      return "TakTick'e hoş geldiniz — e-postanızı doğrulayın";
    case 'provider-email-verification':
      return 'Hesap e-postanızı doğrulayın — TakTick hizmet veren paneli';
    case 'provider-application-received':
      return 'Başvurunuzu aldık — TakTick hizmet veren kaydı';
    case 'provider-application-approved':
      return 'Başvurunuz onaylandı — teklif vermeye başlayabilirsiniz';
    case 'request-received':
      return 'Talebiniz alındı — inceleniyor';
    case 'request-published':
      return 'Talebiniz yayında — teklifler yolda';
    case 'offer-received':
      return withSuffix('Yeni teklif aldınız', text(data.providerName));
    case 'match-customer':
      return 'Eşleşme tamam — iletişim bilgileri';
    case 'request-available':
      return withSuffix(
        'Bölgenizde yeni talep',
        joinNonEmpty([text(data.categoryName), text(data.district)], ', '),
      );
    case 'offer-accepted':
      return withSuffix('Teklifiniz kabul edildi', text(data.requestNumber));
    case 'offer-not-selected':
      return withSuffix('Teklifiniz bu kez seçilmedi', text(data.requestNumber));
    case 'credit-refunded': {
      // With a forfeited promotion share the honest headline figure is the
      // net; without one the net is the gross and the subject is unchanged.
      const net = int(data.netCredits);
      const forfeited = int(data.promoForfeitedCredits);
      return withSuffix(
        'Krediniz iade edildi',
        forfeited !== null && forfeited > 0 && net !== null
          ? `net ${signedCredits(net)}`
          : formatCredits(int(data.refundedCredits)),
      );
    }
    // The three subjects below are the strings their call sites have always
    // passed, restated here so the switch stays exhaustive. They are the older
    // "TakTic" spelling on purpose: re-skinning these messages was the job, and
    // renaming the product in an inbox is not.
    case 'customer-activation':
      return 'TakTic hesabınızı etkinleştirin';
    case 'provider-claim':
      return 'TakTic hizmet veren başvurunuzu hesabınıza bağlayın';
    case 'request-expiring':
      return 'Talebiniz için süre dolmak üzere';
    case 'request-expired-customer':
      return withSuffix('Talebinizin süresi doldu', text(data.requestNumber));
    case 'request-expired-provider':
      return withSuffix('Teklif verdiğiniz talebin süresi doldu', text(data.requestNumber));
    case 'package-purchase-confirmation':
      return 'Kredi paketiniz hesabınıza yüklendi';
    case 'showcase-placement-activated':
      return withSuffix('Vitrin kartınız yayında', text(data.cardTitle));
    case 'showcase-lead-received':
      return withSuffix('Vitrin kartınızdan yeni talep', text(data.urgencyLabel));
    case 'showcase-lead-breached-customer':
      return 'Yanıt süresi doldu — ne yapmak istersiniz?';
    case 'showcase-lead-breached-provider':
      return withSuffix('Vitrin talebine yanıt süresi doldu', text(data.requestNumber));
    case 'showcase-package-payment-succeeded':
      return withSuffix('Vitrin paketiniz hazır', text(data.packageName));
    case 'showcase-package-payment-failed':
      return 'Vitrin paketi ödemesi tamamlanmadı';
    case 'showcase-card-approved-live':
      return withSuffix('Kartınız onaylandı ve yayında', text(data.cardTitle));
    case 'showcase-card-approved':
      return withSuffix('Vitrin kartınız onaylandı', text(data.cardTitle));
    case 'showcase-placement-ending-7d':
      return withSuffix('Vitrin yayınınızın bitmesine 7 gün kaldı', text(data.cardTitle));
    case 'showcase-placement-ending-3d':
      return withSuffix('Vitrin yayınınız 3 gün içinde bitiyor', text(data.cardTitle));
    case 'showcase-placement-expired':
      return withSuffix('Vitrin yayınınız sona erdi', text(data.cardTitle));
    case 'request-removed':
      return 'Talebiniz yayından kaldırıldı';
    case 'request-report-new-for-support':
      return withSuffix('Yeni talep bildirimi', text(data.requestNumber));
    case 'review-invitation':
      return withSuffix('İşiniz tamamlandı — hizmet vereni değerlendirin', text(data.businessName));
    case 'review-received':
      return withSuffix('Yeni değerlendirme aldınız', text(data.requestNumber));
    case 'review-report-new-for-support':
      return 'Yeni değerlendirme bildirimi';
    // The scope is the news: a customer whose comment was taken down still
    // has their stars on the provider's profile, and the subject says so.
    case 'review-removed':
      return withSuffix(
        `${text(data.scopeLabel) ?? 'Değerlendirmeniz'} kaldırıldı`,
        text(data.requestNumber),
      );
    // The ticket's own subject is the suffix on all five, because it is the one
    // thing that tells two tickets apart in a mailbox — and it is truncated,
    // because a customer may type two hundred characters into it and a subject
    // line that runs past what an inbox shows tells nobody anything.
    case 'support-ticket-created':
      return withSuffix('Destek talebiniz alındı', ticketSubject(data));
    case 'support-ticket-new-for-support':
      return withSuffix('Yeni destek talebi', ticketSubject(data));
    case 'support-ticket-customer-reply':
      return withSuffix('Destek talebine müşteri yanıtı', ticketSubject(data));
    case 'support-ticket-admin-reply':
      return withSuffix('Destek talebinize yanıt', ticketSubject(data));
    case 'support-ticket-status-changed':
      return withSuffix(statusChangeSubject(data), ticketSubject(data));
    // The hizmet veren half. The two that reach the support mailbox say which
    // desk they came from in the subject line itself, because an operator
    // triaging an inbox sorts on subjects and should not have to open a message
    // to find out which side of the marketplace is waiting. The three that go to
    // the hizmet veren say nothing of the kind — they are addressed to somebody
    // who already knows who they are.
    case 'support-ticket-provider-created':
      return withSuffix('Destek talebiniz alındı', ticketSubject(data));
    case 'support-ticket-provider-new-for-support':
      return withSuffix('Yeni destek talebi (hizmet veren)', ticketSubject(data));
    case 'support-ticket-provider-reply':
      return withSuffix('Destek talebine hizmet veren yanıtı', ticketSubject(data));
    case 'support-ticket-provider-admin-reply':
      return withSuffix('Destek talebinize yanıt', ticketSubject(data));
    case 'support-ticket-provider-status-changed':
      return withSuffix(statusChangeSubject(data), ticketSubject(data));
  }
}

/** How much of the customer's own subject a subject line carries. */
const TICKET_SUBJECT_IN_SUBJECT_LINE = 70;

function ticketSubject(data: Data): string | null {
  return truncate(text(data.ticketSubject), TICKET_SUBJECT_IN_SUBJECT_LINE);
}

/**
 * What a status change is called in an inbox.
 *
 * Each status gets its own sentence rather than one "durumu güncellendi" for
 * all four, because the status *is* the news: a customer scanning their inbox
 * should not have to open the message to find out whether their ticket was
 * resolved or closed. A status this build does not know falls back to the
 * neutral wording instead of naming a code.
 */
function statusChangeSubject(data: Data): string {
  switch (text(data.status)) {
    case 'OPEN':
      return 'Destek talebiniz yeniden açıldı';
    case 'IN_PROGRESS':
      return 'Destek talebiniz inceleniyor';
    case 'RESOLVED':
      return 'Destek talebiniz çözümlendi';
    case 'CLOSED':
      return 'Destek talebiniz kapatıldı';
    default:
      return 'Destek talebinizin durumu güncellendi';
  }
}

export function renderTransactionalEmail(
  template: TransactionalEmailTemplate,
  message: NotificationMessage,
  branding: EmailBranding,
): RenderedDocument {
  return renderDocument(buildDocument(template, message), branding);
}

/** Exposed for tests, which assert on the block model as well as the markup. */
export function buildDocument(
  template: TransactionalEmailTemplate,
  message: NotificationMessage,
): EmailDocument {
  const data = message.data ?? {};
  const fullName = text(data.fullName) ?? GENERIC_RECIPIENT;
  const subject = message.subject;

  switch (template) {
    case 'password-reset':
      return passwordReset(subject, fullName, data, message.actionUrl);
    case 'email-verification':
      return emailVerification(subject, fullName, data, message.actionUrl);
    case 'provider-email-verification':
      return providerEmailVerification(subject, fullName, data, message.actionUrl);
    case 'provider-application-received':
      return providerApplicationReceived(subject, fullName, data);
    case 'provider-application-approved':
      return providerApplicationApproved(subject, fullName, data);
    case 'request-received':
      return requestReceived(subject, fullName, data);
    case 'request-published':
      return requestPublished(subject, fullName, data);
    case 'offer-received':
      return offerReceived(subject, fullName, data);
    case 'match-customer':
      return matchCustomer(subject, fullName, data);
    case 'request-available':
      return requestAvailable(subject, fullName, data);
    case 'offer-accepted':
      return offerAccepted(subject, fullName, data);
    case 'offer-not-selected':
      return offerNotSelected(subject, fullName, data);
    case 'credit-refunded':
      return creditRefunded(subject, fullName, data);
    case 'customer-activation':
      return customerActivation(subject, fullName, data, message.actionUrl);
    case 'provider-claim':
      return providerClaim(subject, fullName, data, message.actionUrl);
    case 'request-expiring':
      return requestExpiring(subject, fullName, data);
    case 'request-expired-customer':
      return requestExpiredCustomer(subject, fullName, data);
    case 'request-expired-provider':
      return requestExpiredProvider(subject, fullName, data);
    case 'package-purchase-confirmation':
      return packagePurchaseConfirmation(subject, fullName, data);
    case 'showcase-placement-activated':
      return showcasePlacementActivated(subject, fullName, data);
    case 'showcase-lead-received':
      return showcaseLeadReceived(subject, fullName, data);
    case 'showcase-lead-breached-customer':
      return showcaseLeadBreachedCustomer(subject, fullName, data);
    case 'showcase-lead-breached-provider':
      return showcaseLeadBreachedProvider(subject, fullName, data);
    case 'showcase-package-payment-succeeded':
      return showcasePackagePaymentSucceeded(subject, fullName, data);
    case 'showcase-package-payment-failed':
      return showcasePackagePaymentFailed(subject, fullName, data);
    case 'showcase-card-approved-live':
      return showcaseCardApprovedLive(subject, fullName, data);
    case 'showcase-card-approved':
      return showcaseCardApproved(subject, fullName, data);
    case 'showcase-placement-ending-7d':
      return showcasePlacementEnding(subject, fullName, data, 7);
    case 'showcase-placement-ending-3d':
      return showcasePlacementEnding(subject, fullName, data, 3);
    case 'showcase-placement-expired':
      return showcasePlacementExpired(subject, fullName, data);
    case 'request-removed':
      return requestRemoved(subject, fullName, data);
    case 'request-report-new-for-support':
      return requestReportNewForSupport(subject, fullName, data);
    case 'review-invitation':
      return reviewInvitation(subject, fullName, data);
    case 'review-received':
      return reviewReceived(subject, fullName, data);
    case 'review-report-new-for-support':
      return reviewReportNewForSupport(subject, fullName, data);
    case 'review-removed':
      return reviewRemoved(subject, fullName, data);
    case 'support-ticket-created':
      return supportTicketCreated(subject, fullName, data);
    case 'support-ticket-new-for-support':
      return supportTicketNewForSupport(subject, fullName, data);
    case 'support-ticket-customer-reply':
      return supportTicketCustomerReply(subject, fullName, data);
    case 'support-ticket-admin-reply':
      return supportTicketAdminReply(subject, fullName, data);
    case 'support-ticket-status-changed':
      return supportTicketStatusChanged(subject, fullName, data);
    case 'support-ticket-provider-created':
      return supportTicketProviderCreated(subject, fullName, data);
    case 'support-ticket-provider-new-for-support':
      return supportTicketProviderNewForSupport(subject, fullName, data);
    case 'support-ticket-provider-reply':
      return supportTicketProviderReply(subject, fullName, data);
    case 'support-ticket-provider-admin-reply':
      return supportTicketProviderAdminReply(subject, fullName, data);
    case 'support-ticket-provider-status-changed':
      return supportTicketProviderStatusChanged(subject, fullName, data);
  }
}

// ───────────────────────── 01 · auth.password_reset_requested ────────────────

function passwordReset(
  subject: string,
  fullName: string,
  data: Data,
  actionUrl: string | undefined,
): EmailDocument {
  const minutes = int(data.expiryMinutes);
  const validity = minutes === null ? null : `${minutes} dakika`;

  return {
    subject,
    preheader: validity
      ? `Şifre sıfırlama bağlantınız ${validity} boyunca geçerli.`
      : 'Şifre sıfırlama bağlantınızı kullanarak yeni şifrenizi belirleyebilirsiniz.',
    audience: 'HESAP',
    kicker: 'Güvenlik',
    heading: 'Şifrenizi sıfırlayın',
    fullName,
    // No settings link on a security message: the recipient may not be signed
    // in, and a reset mail should carry exactly one destination.
    accountUrl: null,
    blocks: compact([
      paragraph(
        'TakTick hesabınız için şifre sıfırlama talebi aldık. Yeni şifrenizi belirlemek için ' +
          'aşağıdaki butonu kullanın.',
      ),
      spacer(6),
      cta('Yeni şifre belirle', actionUrl, 'primary'),
      spacer(24),
      dataTable([
        row('Bağlantı geçerliliği', validity),
        row('Talep zamanı', formatDateTime(data.requestedAt)),
        // The handoff had a "Cihaz" row here. Nothing records the browser or
        // the city a reset was requested from, and a fabricated one would be
        // worse than useless in a message whose job is to help the reader
        // decide whether the request was theirs.
      ]),
      spacer(20),
      note('Bu talebi siz yapmadıysanız bu e-postayı yok sayabilirsiniz; şifreniz değişmez.'),
    ]),
  };
}

// ───────────────────────────── 02 · customer.registered ──────────────────────

function emailVerification(
  subject: string,
  fullName: string,
  data: Data,
  actionUrl: string | undefined,
): EmailDocument {
  const days = int(data.expiryDays);

  return {
    subject,
    preheader: 'Hesabınızı doğrulayın ve ilk talebinizi dakikalar içinde oluşturun.',
    audience: 'HİZMET ALAN',
    kicker: 'Yeni hesap',
    // The handoff greeted with a first name here ("Hoş geldiniz, Deniz"), which
    // the same handoff's editorial rules forbid everywhere else. The salutation
    // below carries the name; the heading does not.
    heading: "TakTick'e hoş geldiniz",
    fullName,
    accountUrl: null,
    blocks: compact([
      paragraph(
        'TakTick hesabınız oluşturuldu. Kullanmaya başlamak için e-posta adresinizi doğrulayın.',
      ),
      spacer(6),
      cta('E-postamı doğrula', actionUrl, 'primary'),
      spacer(28),
      sectionLabel('Nasıl çalışır'),
      dataTable([
        row('1 · Talep', 'İhtiyacınızı birkaç soruyla anlatın'),
        row('2 · Teklif', 'Bölgenizdeki uzmanlardan teklifler gelsin'),
        row('3 · Seçim', 'Teklifleri karşılaştırın, uzmanla iletişime geçin'),
      ]),
      spacer(22),
      note(
        days === null
          ? 'Bu hesabı siz oluşturmadıysanız e-postayı yok sayın.'
          : `Doğrulama bağlantısı ${days} gün geçerlidir. Bu hesabı siz oluşturmadıysanız e-postayı yok sayın.`,
      ),
    ]),
  };
}

// ─────────────────────── 03 · provider.application_submitted ─────────────────

function providerApplicationReceived(subject: string, fullName: string, data: Data): EmailDocument {
  const businessName = text(data.businessName);
  const profileUrl = text(data.profileUrl);

  return {
    subject,
    preheader: 'Başvurunuz incelemede. Sonuçlandığında e-posta ile bilgilendirileceksiniz.',
    audience: 'HİZMET VEREN',
    kicker: 'Başvuru alındı',
    heading: 'Başvurunuz bize ulaştı',
    fullName,
    accountUrl: null,
    blocks: compact([
      paragraph(
        businessName
          ? `${businessName} adına yaptığınız hizmet veren başvurusunu aldık. Ekibimiz ` +
              'belgelerinizi ve hizmet alanlarınızı inceliyor.'
          : 'Hizmet veren başvurunuzu aldık. Ekibimiz belgelerinizi ve hizmet alanlarınızı inceliyor.',
      ),
      spacer(4),
      dataTable([
        // No "Başvuru no" row: provider applications carry no display number.
        row('İşletme', businessName),
        row('Kategoriler', text(data.categories)),
        row('Bölge', text(data.areas)),
        row('Durum', text(data.statusLabel)),
      ]),
      spacer(22),
      paragraph(
        profileUrl
          ? 'İnceleme sonuçlandığında e-posta ile bilgilendirileceksiniz. Bu sırada işletme ' +
              'profilinizi tamamlayarak onay sürecini hızlandırabilirsiniz.'
          : 'İnceleme sonuçlandığında e-posta ile bilgilendirileceksiniz.',
      ),
      // Only when the application already belongs to an account. A guest
      // application cannot be edited by a stranger — ownership is proved
      // through the separate claim link — so linking here would send the
      // applicant to a screen that refuses them.
      cta('Profili tamamla', profileUrl, 'ghost'),
    ]),
  };
}

// ─────────────────────── 04 · provider.application_approved ──────────────────

function providerApplicationApproved(subject: string, fullName: string, data: Data): EmailDocument {
  const businessName = text(data.businessName);

  return {
    subject,
    preheader: 'Hesabınız aktif. Kategori ve bölgelerinizdeki talepleri görebilirsiniz.',
    audience: 'HİZMET VEREN',
    kicker: 'Onaylandı',
    heading: 'Hesabınız aktif',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        businessName
          ? `${businessName} artık TakTick'te yayında. Seçtiğiniz kategori ve bölgelerdeki ` +
              'talepleri görebilir, teklif verebilirsiniz.'
          : "Başvurunuz onaylandı ve profiliniz TakTick'te yayında. Seçtiğiniz kategori ve " +
              'bölgelerdeki talepleri görebilir, teklif verebilirsiniz.',
      ),
      spacer(4),
      dataTable([
        // No "Hoş geldin kredisi" row: there is no welcome grant. Credits come
        // from a purchase or an admin grant, and neither happens on approval.
        row('Aktif kategoriler', text(data.categories)),
        row('Hizmet bölgesi', text(data.areas)),
      ]),
      spacer(24),
      cta('Uygun talepleri gör', text(data.requestsUrl), 'primary'),
      spacer(20),
      note(
        'Teklif maliyeti kategoriye göre değişir; her talebin maliyeti panelinizde talebin ' +
          'yanında görünür. Kredileriniz panelinizdeki bakiye alanında listelenir.',
      ),
    ]),
  };
}

// ───────────────────────────── 05 · request.created ──────────────────────────

function requestReceived(subject: string, fullName: string, data: Data): EmailDocument {
  // What the request is waiting for. Absent on every receipt sent before the
  // field existed — and on a retry of one — which reads as the operator's
  // review, exactly what those receipts said.
  const awaitsVerification = data.nextStep === 'verify';

  return {
    subject,
    preheader: awaitsVerification
      ? 'Telefonunuzu doğrulayın, talebiniz uzmanlara iletilsin.'
      : 'Talebiniz onaylandığında uzmanlara iletilecek.',
    audience: 'HİZMET ALAN',
    kicker: 'Talep alındı',
    heading: awaitsVerification ? 'Telefonunuzu doğrulayın' : 'Talebiniz inceleniyor',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        awaitsVerification
          ? 'Telefon numaranızı doğruladığınızda talebiniz uygun hizmet verenlere anında iletilir.'
          : 'Ekibimiz talebinizi inceledikten sonra uygun hizmet verenlere iletilir.',
      ),
      spacer(4),
      dataTable([
        row('Talep no', text(data.requestNumber)),
        row('Kategori', text(data.categoryName)),
        row('Konum', formatLocation(text(data.city), text(data.district))),
        row('Tercih edilen zaman', preferredTime(data)),
        row('Durum', text(data.statusLabel)),
      ]),
      spacer(24),
      cta('Talebi görüntüle', text(data.requestUrl), 'ghost'),
      spacer(20),
      note('Talebiniz onaylandığında ve ilk teklif geldiğinde size ayrıca e-posta göndereceğiz.'),
    ]),
  };
}

// ──────────────────────────── 06 · request.approved ──────────────────────────

function requestPublished(subject: string, fullName: string, data: Data): EmailDocument {
  const requestNumber = text(data.requestNumber);
  const categoryName = text(data.categoryName);
  const district = text(data.district);
  const reached = int(data.reachedProviderCount);

  return {
    subject,
    preheader: 'Talebiniz bölgenizdeki uzmanlara iletildi.',
    audience: 'HİZMET ALAN',
    kicker: 'Yayında',
    heading: 'Talebiniz onaylandı',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        joinNonEmpty(
          [
            requestNumber ? `${requestNumber} numaralı talebiniz onaylandı` : 'Talebiniz onaylandı',
            district && categoryName
              ? `ve ${district} bölgesindeki ${categoryName.toLocaleLowerCase('tr-TR')} uzmanlarına iletildi.`
              : 've eşleşen uzmanlara iletildi.',
          ],
          ' ',
        ) ?? 'Talebiniz onaylandı ve eşleşen uzmanlara iletildi.',
      ),
      spacer(4),
      dataTable([
        row('Talep no', requestNumber),
        row('Kategori', categoryName),
        // A real count: exactly the audience the fan-out was sent to, computed
        // by the same matching rules. The handoff's "Beklenen teklif" range
        // beside it is a forecast nothing in this product makes, so it is gone.
        row('Ulaşılan uzman', reached === null ? null : `${reached} uzman`),
      ]),
      spacer(24),
      cta('Talebimi takip et', text(data.requestUrl), 'primary'),
      spacer(20),
      note(
        'Her yeni teklifte bildirim alırsınız. Teklif almayı durdurmak isterseniz talebinizi ' +
          'panelinizden iptal edebilirsiniz.',
      ),
    ]),
  };
}

// ────────────────────────────── 07 · offer.created ───────────────────────────

function offerReceived(subject: string, fullName: string, data: Data): EmailDocument {
  const providerName = text(data.providerName);
  const requestNumber = text(data.requestNumber);
  const openOfferCount = int(data.openOfferCount);

  return {
    subject,
    preheader: providerName
      ? `${providerName} talebiniz için teklif gönderdi.`
      : 'Talebiniz için yeni bir teklif geldi.',
    audience: 'HİZMET ALAN',
    kicker: 'Yeni teklif',
    heading: 'Talebiniz için yeni bir teklif var',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        [
          requestNumber ? `${requestNumber} numaralı talebiniz için` : 'Talebiniz için',
          providerName ? `${providerName} teklif gönderdi.` : 'yeni bir teklif gönderildi.',
        ].join(' '),
      ),
      spacer(4),
      dataTable([
        // Only the public profile field. The handoff's rating and job count rows
        // describe a reputation system this platform does not have.
        row('Uzman', providerName),
        row('Teklif tutarı', formatMoneyMinor(int(data.offerAmountMinor))),
        row('Uygunluk', formatDate(data.availability)),
        row('Not', truncate(text(data.offerNote))),
      ]),
      spacer(24),
      cta('Teklifi incele', text(data.offersUrl), 'primary'),
      spacer(18),
      note(
        openOfferCount === null
          ? 'Panelinizden teklifleri yan yana karşılaştırabilirsiniz.'
          : `Bu talep için toplam ${openOfferCount} teklifiniz var. Panelinizden teklifleri yan yana karşılaştırabilirsiniz.`,
      ),
    ]),
  };
}

// ─────────────────────── 08 · offer.accepted → customer ──────────────────────

function matchCustomer(subject: string, fullName: string, data: Data): EmailDocument {
  const businessName = text(data.businessName);
  const contactName = text(data.contactName);
  const contactPhone = text(data.contactPhone);
  // Contact details reach this message only when the accept transaction really
  // opened them: the flag on, the disclosure accepted, and the audit row
  // written. With any of those missing the sender passes nothing and the rows
  // below simply do not exist — the message stays true either way.
  const hasContact = Boolean(contactName || contactPhone);

  return {
    subject,
    preheader: businessName
      ? `${businessName} ile eşleştiniz.`
      : 'Seçtiğiniz uzmanla eşleşmeniz tamamlandı.',
    audience: 'HİZMET ALAN',
    kicker: 'Eşleşme',
    heading: 'Uzmanınızla eşleştiniz',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      // Phrased so no Turkish possessive suffix has to be attached to a name
      // the platform did not choose. "X tarafından gönderilen teklif" is
      // correct for every business name; "X'in teklifi" would need vowel
      // harmony and an apostrophe rule this code has no business guessing.
      paragraph(
        [
          businessName
            ? `${businessName} tarafından gönderilen teklifi onayladınız.`
            : 'Seçtiğiniz uzmanın teklifini onayladınız.',
          hasContact
            ? 'İletişim bilgileri aşağıda; uzman da sizin bilgilerinizi aldı.'
            : 'Eşleşmenin ayrıntılarını panelinizden görüntüleyebilirsiniz.',
        ].join(' '),
      ),
      spacer(4),
      dataTable([
        row('İşletme', businessName),
        row('Yetkili', contactName),
        row('Telefon', contactPhone),
        row('Kabul edilen tutar', formatMoneyMinor(int(data.acceptedAmountMinor))),
        row(
          'Talep',
          joinNonEmpty([text(data.requestNumber), text(data.categoryName)], ' · '),
        ),
      ]),
      spacer(24),
      // The handoff pointed at a messaging screen. There is no messaging
      // feature, so this is the request page the customer really has.
      cta('Talebimi aç', text(data.requestUrl), 'primary'),
      spacer(20),
      note(
        'İş tamamlandığında talebinizi panelinizden tamamlandı olarak işaretleyebilirsiniz.',
      ),
    ]),
  };
}

// ──────────────────── 09 · request.approved → matching providers ─────────────

function requestAvailable(subject: string, fullName: string, data: Data): EmailDocument {
  const district = text(data.district);
  const creditCost = int(data.creditCost);
  const balance = int(data.creditBalance);
  const qualityScore = int(data.qualityScore);

  return {
    subject,
    preheader: joinNonEmpty(
      [
        'Yeni bir talep kriterlerinizle eşleşti.',
        creditCost === null ? null : `Teklif maliyeti ${formatCredits(creditCost)}.`,
      ],
      ' ',
    ) as string,
    audience: 'HİZMET VEREN',
    kicker: 'Yeni talep',
    heading: 'Kriterlerinize uyan bir talep var',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        district
          ? `${district} bölgesinde, aktif kategorilerinizden birinde yeni bir talep yayınlandı.`
          : 'Hizmet bölgenizde, aktif kategorilerinizden birinde yeni bir talep yayınlandı.',
      ),
      spacer(4),
      dataTable([
        row('Talep no', text(data.requestNumber)),
        row('Kategori', text(data.categoryName)),
        // City and district only. The neighbourhood, the address note and every
        // customer contact field stay out of a message that goes to everybody
        // who matched — the same line the accepted-work brief draws.
        row('Konum', formatLocation(text(data.city), district)),
        row('Kalite puanı', qualityScore === null ? null : `${qualityScore} / 100`),
        // The real per-category price, never a fixed figure.
        row('Teklif maliyeti', formatCredits(creditCost)),
        // No "Mevcut teklif" row: how many rivals are already on a request is
        // not something the discovery screen tells providers either.
      ]),
      spacer(24),
      cta('Talebi gör ve teklif ver', text(data.requestUrl), 'primary'),
      spacer(20),
      note(
        balance === null
          ? 'Teklif vermeden önce kredi bakiyenizi panelinizden görebilirsiniz.'
          : `Bakiyeniz: ${formatCredits(balance)}.`,
      ),
    ]),
  };
}

// ──────────────────── 10 · offer.accepted → winning provider ─────────────────

function offerAccepted(subject: string, fullName: string, data: Data): EmailDocument {
  const customerName = text(data.customerName);
  const customerPhone = text(data.customerPhone);
  const requestNumber = text(data.requestNumber);
  const hasContact = Boolean(customerName || customerPhone);

  return {
    subject,
    preheader: hasContact
      ? 'Müşteri teklifinizi onayladı. İletişim bilgileri içeride.'
      : 'Müşteri teklifinizi onayladı.',
    audience: 'HİZMET VEREN',
    kicker: 'Kabul edildi',
    heading: 'Teklifiniz kabul edildi',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        joinNonEmpty(
          [
            customerName ? `${customerName},` : 'Müşteri,',
            requestNumber ? `${requestNumber} numaralı talep için` : 'talebi için',
            'teklifinizi onayladı.',
            hasContact ? 'Müşteriye ait iletişim bilgileri aşağıdadır.' : null,
          ],
          ' ',
        ) as string,
      ),
      spacer(4),
      dataTable([
        row('Müşteri', customerName),
        row('Telefon', customerPhone),
        // District and city, exactly what the offer already quoted for. The
        // neighbourhood and the address note are not part of the brief.
        row('Adres', formatLocation(text(data.city), text(data.district))),
        row('Kabul edilen tutar', formatMoneyMinor(int(data.acceptedAmountMinor))),
        row('Tercih edilen zaman', preferredTime(data)),
      ]),
      spacer(24),
      cta('Talebi panelde aç', text(data.offerUrl), 'primary'),
      spacer(20),
      note(
        'Talebin ayrıntılarını ve müşterinin zorunlu sorulara verdiği yanıtları panelinizdeki ' +
          'teklif sayfasından görebilirsiniz.',
      ),
    ]),
  };
}

// ─────────────────── 11 · offer.rejected → unselected provider ───────────────

function offerNotSelected(subject: string, fullName: string, data: Data): EmailDocument {
  const refundWindowHours = int(data.refundWindowHours);
  const requestNumber = text(data.requestNumber);

  return {
    subject,
    preheader: 'Talep başka bir uzmanla sonuçlandı. Yeni talepler sizi bekliyor.',
    audience: 'HİZMET VEREN',
    kicker: 'Sonuçlandı',
    heading: 'Bu talep başka bir uzmanla sonuçlandı',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        `${requestNumber ? `${requestNumber} numaralı talep` : 'Talep'} için verdiğiniz teklif ` +
          'seçilmedi. Bu talebi kapattık; bölgenizde yeni talepler açılmaya devam ediyor.',
      ),
      spacer(4),
      dataTable([
        row('Talep', joinNonEmpty([requestNumber, text(data.categoryName)], ' · ')),
        row('Teklifiniz', formatMoneyMinor(int(data.offerAmountMinor))),
        row('Sonuç', 'Başka uzman seçildi'),
        // No "kabul oranınız" row: nothing computes an acceptance rate.
      ]),
      spacer(24),
      cta('Uygun talepleri gör', text(data.requestsUrl), 'primary'),
      spacer(20),
      // The real policy, and the only one. Losing the request decides nothing
      // about the credit: what decides it is whether the customer ever opened
      // this offer. Saying "not refundable" here was true under the previous
      // rules and would now be a false denial — an offer closed by a competing
      // acceptance that the customer never opened is refunded like any other.
      //
      // Built from this offer's own window, and omitted entirely for an offer
      // the policy does not govern: a fixed sentence would promise 48 hours to
      // a provider whose offer was sold at 72, and promise anything at all to
      // one sold before the rule existed.
      refundWindowHours === null ? null : note(unviewedOfferRefundNotice(refundWindowHours)),
    ]),
  };
}

// ───────────────────────────── 12 · credit.refunded ──────────────────────────

function creditRefunded(subject: string, fullName: string, data: Data): EmailDocument {
  const refunded = int(data.refundedCredits);
  const requestNumber = text(data.requestNumber);
  const reason = text(data.refundReason);
  // CMP-004 S4: the promotion figures, present only when a promo lot paid
  // part of the offer. Without them every block below is what it always was.
  const forfeited = int(data.promoForfeitedCredits) ?? 0;
  const forfeitedExpired = int(data.promoForfeitedExpiredCredits) ?? 0;
  const forfeitedRevoked = int(data.promoForfeitedRevokedCredits) ?? 0;
  const restored = int(data.promoRestoredCredits) ?? 0;
  const net = int(data.netCredits);

  return {
    subject,
    preheader: refunded === null
      ? 'Teklif krediniz bakiyenize geri yüklendi.'
      : `${formatCredits(refunded)} bakiyenize geri yüklendi.`,
    audience: 'HİZMET VEREN',
    kicker: 'Kredi iadesi',
    heading:
      refunded === null ? 'Krediniz iade edildi' : `${formatCredits(refunded)} iade edildi`,
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        joinNonEmpty(
          [
            requestNumber ? `${requestNumber} numaralı talep için` : 'Bir talep için',
            'harcadığınız teklif kredisini bakiyenize geri yükledik.',
          ],
          ' ',
        ) as string,
      ),
      spacer(4),
      dataTable([
        row('Talep', joinNonEmpty([requestNumber, text(data.categoryName)], ' · ')),
        // The reason as a fixed label from the closed policy list — never the
        // stored reason string, which carries an admin's free-text note.
        row('İade nedeni', reason),
        row('İade edilen', formatCredits(refunded)),
        // Only when a promotion share was taken back: the figure the wallet
        // lost again, and the net the provider actually gained. No row for a
        // zero, and never a negative net — a forfeit is bounded by the share.
        forfeited > 0 ? row('Geri alınan promosyon kredisi', `−${formatCredits(forfeited)}`) : null,
        forfeited > 0 && net !== null ? row('Net değişim', signedCredits(net)) : null,
        row('Önceki bakiye', formatCredits(int(data.previousBalance))),
        row('Güncel bakiye', formatCredits(int(data.currentBalance))),
      ]),
      forfeited > 0 ? spacer(12) : null,
      forfeited > 0 ? note(promoForfeitNotice(forfeited, forfeitedExpired, forfeitedRevoked)) : null,
      restored > 0 ? spacer(12) : null,
      restored > 0
        ? note(`Bunun ${restored} kredisi promosyon kredisi olarak geri döndü; son kullanma tarihi değişmedi.`)
        : null,
      spacer(24),
      cta('Bakiyemi gör', text(data.creditsUrl), 'ghost'),
      spacer(20),
      note('İade işlemleri kredi geçmişinizde iade kaydı olarak listelenir.'),
    ]),
  };
}

/** `+2 kredi` / `0 kredi`: a net figure with its sign, for the subject and the net row. */
function signedCredits(value: number): string {
  const formatted = formatCredits(Math.abs(value)) ?? `${Math.abs(value)} kredi`;
  return value > 0 ? `+${formatted}` : value < 0 ? `−${formatted}` : formatted;
}

/**
 * Why part of the refund did not come back, in the provider's terms: the
 * promotion that paid it had died. Says explicitly that nothing was taken
 * from paid credit and that no debt exists — the two things a "−3" beside a
 * refund would otherwise suggest.
 */
function promoForfeitNotice(total: number, expired: number, revoked: number): string {
  const cause =
    expired > 0 && revoked > 0
      ? 'ait olduğu kampanyanın süresi dolduğu ya da promosyon geri alındığı için'
      : revoked > 0
        ? 'ait olduğu promosyon geri alındığı için'
        : 'ait olduğu kampanyanın süresi dolduğu için';
  return `${formatCredits(total)} promosyon kredisi, ${cause} bakiyenize dönmedi. Ücretli bakiyenizden hiçbir şey düşülmedi ve eksi bakiye oluşmadı.`;
}

// ────────────────────── 13 · customer.activation_requested ───────────────────

/**
 * The guest activation link, moved onto the design system.
 *
 * Everything the plain renderer said, it still says: the same instruction, the
 * same absolute expiry moment, the same "ignore this if it was not you", and
 * the same single-use URL as the one call to action. What is gone is the
 * paste-this-address fallback the old HTML carried under the link — the token
 * now appears exactly once in each body, which is the rule every other
 * token-bearing message here already follows.
 *
 * The recipient's name comes from this template's own long-standing `name`
 * variable rather than from `fullName`; the call site is unchanged.
 */
function customerActivation(
  subject: string,
  fullName: string,
  data: Data,
  actionUrl: string | undefined,
): EmailDocument {
  const validUntil = formatDateTime(data.expiresAt);

  return {
    subject,
    preheader: validUntil
      ? `Etkinleştirme bağlantınız ${validUntil} tarihine kadar geçerli.`
      : 'Etkinleştirme bağlantınızı kullanarak hesabınızı açabilirsiniz.',
    audience: 'HESAP',
    kicker: 'Hesap etkinleştirme',
    heading: 'Hesabınızı etkinleştirin',
    fullName: text(data.name) ?? fullName,
    // No settings link: the recipient has no usable account yet, which is the
    // whole reason this message exists.
    accountUrl: null,
    blocks: compact([
      paragraph('TakTic hesabınızı etkinleştirmek için aşağıdaki butonu kullanın.'),
      spacer(6),
      cta('Hesabımı etkinleştir', actionUrl, 'primary'),
      spacer(24),
      dataTable([row('Bağlantı geçerliliği', validUntil)]),
      spacer(20),
      note('Bu isteği siz yapmadıysanız bu e-postayı yok sayabilirsiniz.'),
    ]),
  };
}

// ────────────────────────── 14 · provider.claim_invited ──────────────────────

/**
 * The claim invitation, moved onto the design system.
 *
 * The second paragraph is load-bearing and is reproduced verbatim: a claim
 * proves who owns an application and says nothing whatever about how its
 * moderation went. An application still under review must not read this as an
 * approval.
 */
function providerClaim(
  subject: string,
  fullName: string,
  data: Data,
  actionUrl: string | undefined,
): EmailDocument {
  const businessName = text(data.businessName);
  const validUntil = formatDateTime(data.expiresAt);
  // Addressed to the contact named on the application. A guest application
  // recorded without one falls back to the business it is about, which is a
  // truer salutation than the generic default.
  const recipient = fullName === GENERIC_RECIPIENT ? (businessName ?? fullName) : fullName;

  return {
    subject,
    preheader: 'Başvurunuzu hesabınıza bağlayarak takip etmeye başlayabilirsiniz.',
    audience: 'HİZMET VEREN',
    kicker: 'Başvuru sahipliği',
    heading: 'Başvurunuzu hesabınıza bağlayın',
    fullName: recipient,
    accountUrl: null,
    blocks: compact([
      paragraph(
        'TakTic üzerinde bu işletme adına oluşturulmuş bir hizmet veren başvurusu bulunuyor. ' +
          'Başvuruyu kendi hesabınıza bağlamak için aşağıdaki butonu kullanın.',
      ),
      spacer(6),
      cta('Başvuruyu hesabıma bağla', actionUrl, 'primary'),
      spacer(24),
      dataTable([
        row('İşletme', businessName),
        row('Bağlantı geçerliliği', validUntil),
      ]),
      spacer(20),
      note(
        'Bu bağlantı yalnızca başvurunun sahipliğini doğrular; başvurunun değerlendirme sonucu ' +
          'hakkında bir anlam taşımaz. Böyle bir başvuru yaptırmadıysanız bu e-postayı yok ' +
          'sayabilirsiniz.',
      ),
    ]),
  };
}

// ─────────────────── provider.email_verification (AUTH-PROVIDER-CONTACT-001) ──

/**
 * The provider's twin of `emailVerification`: same link, same expiry, same
 * single use — worded for somebody who already has a panel rather than for a
 * customer about to open a first request. Nothing is gated on it, and the copy
 * says so: the account keeps working, the proof is a fact about the mailbox.
 */
function providerEmailVerification(
  subject: string,
  fullName: string,
  data: Data,
  actionUrl: string | undefined,
): EmailDocument {
  const days = int(data.expiryDays);

  return {
    subject,
    preheader: 'Hizmet veren hesabınızın e-posta adresini doğrulayın.',
    audience: 'HİZMET VEREN',
    kicker: 'Hesap doğrulama',
    heading: 'Hesap e-postanızı doğrulayın',
    fullName,
    accountUrl: null,
    blocks: compact([
      paragraph(
        'Bu adres TakTick hizmet veren hesabınıza kayıtlı. Adresin size ait olduğunu ' +
          'doğrulamak için aşağıdaki butonu kullanın.',
      ),
      spacer(6),
      cta('E-postamı doğrula', actionUrl, 'primary'),
      spacer(24),
      note(
        'Doğrulama hesabınızın kullanımını değiştirmez: teklif verme, profil ve başvuru akışları ' +
          'doğrulama olmadan da çalışır. Panelinizdeki "Hesap iletişimi" kartında durumu görebilirsiniz.',
      ),
      spacer(12),
      note(
        days === null
          ? 'Bu isteği siz yapmadıysanız e-postayı yok sayın.'
          : `Doğrulama bağlantısı ${days} gün geçerlidir. Bu isteği siz yapmadıysanız e-postayı yok sayın.`,
      ),
    ]),
  };
}

// ─────────────────────── 15 · request.expiring_reminder ──────────────────────

/**
 * The single day-7 nudge, moved onto the design system.
 *
 * It carries no call to action, and that is not an omission: the reminder has
 * never linked anywhere, and the design drops a button it has no URL for rather
 * than inventing a destination. The editorial constraint is unchanged too — it
 * states that the window is closing and stops there. It must not describe the
 * request as verified, and it must not suggest offers are on their way.
 */
function requestExpiring(subject: string, fullName: string, data: Data): EmailDocument {
  const requestNumber = text(data.requestNumber);
  const categoryName = text(data.categoryName);
  const remainingDays = int(data.remainingDays);
  const openDays = int(data.openDays);

  return {
    subject,
    preheader:
      remainingDays === null
        ? 'Talebiniz hâlâ açık; geçerlilik süresi dolmak üzere.'
        : `Talebinizin süresinin dolmasına ${remainingDays} gün kaldı.`,
    audience: 'HİZMET ALAN',
    kicker: 'Süre uyarısı',
    heading: 'Talebinizin süresi dolmak üzere',
    fullName,
    accountUrl: null,
    blocks: compact([
      paragraph(openRequestLine(requestNumber, categoryName)),
      spacer(4),
      dataTable([
        row('Talep', requestNumber),
        row('Kategori', categoryName),
        row('Açık kalma süresi', openDays === null ? null : `${openDays} gün`),
        row('Kalan süre', remainingDays === null ? null : `${remainingDays} gün`),
        row('Son geçerlilik', formatDateTime(data.expiresAt)),
      ]),
      spacer(22),
      paragraph('Talebinizi TakTic üzerinden görüntüleyebilir veya güncelleyebilirsiniz.'),
    ]),
  };
}

/** The opening sentence, narrowed to whatever of the two facts is actually held. */
function openRequestLine(
  requestNumber: string | null,
  categoryName: string | null,
): string {
  if (requestNumber && categoryName) {
    return `${categoryName} kategorisindeki ${requestNumber} numaralı talebiniz hâlâ açık.`;
  }

  return requestNumber ? `${requestNumber} numaralı talebiniz hâlâ açık.` : 'Talebiniz hâlâ açık.';
}

// ────────────── 15b · request.expired → the customer who asked ───────────────

/**
 * The other end of the clock the day-7 reminder warned about.
 *
 * Sent once, after the transition to EXPIRED has committed, and only then: this
 * message is the customer's notice that their request closed on its own, so it
 * must never go out for a request that was matched, cancelled or completed.
 *
 * Editorially it states a fact and offers the one thing that is actually
 * available — opening a new request. It does not apologise for the market, it
 * does not claim anybody looked at the request, and it does not say offers were
 * coming: nothing here knows either of those things.
 */
function requestExpiredCustomer(subject: string, fullName: string, data: Data): EmailDocument {
  const requestNumber = text(data.requestNumber);
  const categoryName = text(data.categoryName);
  const openDays = int(data.openDays);

  return {
    subject,
    preheader: 'Talebiniz açık kalma süresini doldurdu ve kapatıldı.',
    audience: 'HİZMET ALAN',
    kicker: 'Süre doldu',
    heading: 'Talebinizin süresi doldu',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(expiredRequestLine(requestNumber, categoryName, openDays)),
      spacer(4),
      dataTable([
        row('Talep', requestNumber),
        row('Kategori', categoryName),
        row('Açık kalma süresi', openDays === null ? null : `${openDays} gün`),
        row('Kapanış zamanı', formatDateTime(data.expiredAt)),
      ]),
      spacer(24),
      cta('Yeni talep oluştur', text(data.newRequestUrl), 'primary'),
      spacer(20),
      note(
        'Süresi dolan talepler yeni teklif alamaz. İhtiyacınız sürüyorsa aynı hizmet için ' +
          'yeni bir talep oluşturabilirsiniz.',
      ),
    ]),
  };
}

// ───────────── 15c · request.expired → the providers who did offer ───────────

/**
 * The same clock event, told to a provider who spent a credit on it.
 *
 * It reaches exactly the providers who made an offer and did not withdraw it —
 * never the far larger group who were merely told the request existed. Somebody
 * who only saw it on their discovery list has nothing to be notified the end of.
 *
 * What this message must not contain is the reason it is a separate template:
 * no customer name, e-mail, phone or address, nothing about how many other
 * providers offered or at what price, and no operator's name — an expiry is a
 * clock decision, and there is no administrator behind it to name.
 *
 * The refund note is the provider's own offer's promise, printed only for an
 * offer the policy actually governs. Expiry itself decides nothing about the
 * credit: what decides it is whether the customer ever opened the offer, which
 * is the refund worker's business and not this message's.
 */
function requestExpiredProvider(subject: string, fullName: string, data: Data): EmailDocument {
  const requestNumber = text(data.requestNumber);
  const refundWindowHours = int(data.refundWindowHours);

  return {
    subject,
    preheader: 'Teklif verdiğiniz talep karara bağlanmadan kapandı.',
    audience: 'HİZMET VEREN',
    kicker: 'Süre doldu',
    heading: 'Teklif verdiğiniz talebin süresi doldu',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        `${requestNumber ? `${requestNumber} numaralı talep` : 'Teklif verdiğiniz talep'} ` +
          'açık kalma süresini doldurduğu için kapatıldı. Müşteri bu talep için bir teklif ' +
          'seçmedi; talep artık yeni teklif almıyor.',
      ),
      spacer(4),
      dataTable([
        row('Talep', joinNonEmpty([requestNumber, text(data.categoryName)], ' · ')),
        // City and district only, exactly as the discovery mail carries them.
        // The neighbourhood, the address note and every customer contact field
        // stay out of a message about somebody else's request.
        row('Konum', formatLocation(text(data.city), text(data.district))),
        row('Teklifiniz', formatMoneyMinor(int(data.offerAmountMinor))),
        row('Sonuç', 'Süre doldu, teklif seçilmedi'),
      ]),
      spacer(24),
      cta('Uygun talepleri gör', text(data.requestsUrl), 'primary'),
      spacer(20),
      refundWindowHours === null ? null : note(unviewedOfferRefundNotice(refundWindowHours)),
    ]),
  };
}

/** The opening sentence, narrowed to whatever of the facts is actually held. */
function expiredRequestLine(
  requestNumber: string | null,
  categoryName: string | null,
  openDays: number | null,
): string {
  const subject =
    requestNumber && categoryName
      ? `${categoryName} kategorisindeki ${requestNumber} numaralı talebiniz`
      : requestNumber
        ? `${requestNumber} numaralı talebiniz`
        : 'Talebiniz';

  return openDays === null
    ? `${subject} açık kalma süresini doldurduğu için kapatıldı.`
    : `${subject} ${openDays} gün açık kaldıktan sonra süresi dolduğu için kapatıldı.`;
}

// ─────────────────── 16 · credits.package_purchase_settled ───────────────────

/**
 * The receipt for a credit package that was paid for and loaded.
 *
 * Every figure is a snapshot column taken at checkout or the ledger row the
 * settlement wrote — the package name, the credits, the price, the currency —
 * so a package repriced or renamed afterwards cannot rewrite what an
 * already-sent receipt said this order was.
 *
 * What is deliberately absent is the entire payment side of the transaction:
 * no provider order id, no correlation token, no webhook field, no event name,
 * no admin note, and nothing about which store or mode settled it. None of it
 * is the buyer's business, some of it is this deployment's own configuration,
 * and a receipt is the wrong place to find out.
 */
function packagePurchaseConfirmation(
  subject: string,
  fullName: string,
  data: Data,
): EmailDocument {
  const packageName = text(data.packageName);
  const credits = formatCredits(int(data.creditAmount));
  const paid = formatMoneyMinorIn(int(data.priceAmountMinor), text(data.currency));

  return {
    subject,
    preheader: credits
      ? `${credits} bakiyenize eklendi.`
      : 'Kredi paketiniz bakiyenize eklendi.',
    audience: 'HİZMET VEREN',
    kicker: 'Satın alma',
    heading: 'Kredi paketiniz hesabınıza yüklendi',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        joinNonEmpty(
          [
            packageName ? `${packageName} paketi için ödemeniz alındı` : 'Ödemeniz alındı',
            credits ? `ve ${credits} bakiyenize eklendi.` : 've paketiniz hesabınıza yüklendi.',
          ],
          ' ',
        ) as string,
      ),
      spacer(4),
      dataTable([
        row('Paket', packageName),
        row('Eklenen kredi', credits),
        row('Ödenen tutar', paid),
        row('Sipariş no', text(data.purchaseNumber)),
        row('İşlem tarihi', formatDateTime(data.paidAt)),
      ]),
      spacer(24),
      cta('Bakiyemi gör', text(data.creditsUrl), 'primary'),
      spacer(20),
      note('Bu satın alma kredi geçmişinizde paket yüklemesi olarak listelenir.'),
    ]),
  };
}

// ───────────────────────────── vitrin, phase two ─────────────────────────────

/**
 * The run is live.
 *
 * Says what was bought and when it ends, and deliberately not what it cost per
 * day or how it ranks. The end date is here because it is the provider's own
 * information and the one thing they need in order to plan a renewal — it is
 * kept out of the *public* feed for the opposite reason, where it would be a
 * competitor's information.
 */
function showcasePlacementActivated(
  subject: string,
  fullName: string,
  data: Data,
): EmailDocument {
  const cardTitle = text(data.cardTitle);

  return {
    subject,
    preheader: cardTitle
      ? `${cardTitle} kartınız ana sayfada yayında.`
      : 'Vitrin kartınız ana sayfada yayında.',
    audience: 'HİZMET VEREN',
    kicker: 'Vitrin',
    heading: 'Vitrin kartınız yayında',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        'Ödemeniz alındı ve kartınız, seçtiğiniz bölgelerde arayan müşterilere gösterilmeye ' +
          'başladı.',
      ),
      spacer(4),
      dataTable([
        row('Kart', cardTitle),
        row('Paket', text(data.packageName)),
        row('Bölgeler', text(data.areaSummary)),
        row('Başlangıç', formatDateTime(data.startAt)),
        row('Bitiş', formatDateTime(data.endAt)),
      ]),
      spacer(24),
      cta('Vitrin kartlarım', text(data.placementUrl), 'primary'),
      spacer(20),
      note(
        'Kartınızdan gelen talepler yalnız size iletilir ve bu talepler için teklif kredisi ' +
          'harcanmaz.',
      ),
    ]),
  };
}

/**
 * A direct lead arrived.
 *
 * The deadline is the point of this message, so it is in the preheader as well
 * as the table: the provider is being told a clock is running, not merely that
 * a request exists.
 *
 * There is no customer telephone number and no e-mail address anywhere in it.
 * Contact details open through `ContactRevealEvent` and through nothing else,
 * and a direct lead is not an exception — the provider answers with an offer,
 * the customer accepts, and the reveal happens on the path it always has.
 */
function showcaseLeadReceived(subject: string, fullName: string, data: Data): EmailDocument {
  const urgencyLabel = text(data.urgencyLabel);
  const slaHours = int(data.slaHours);

  return {
    subject,
    preheader: slaHours
      ? `${slaHours} saat içinde yanıtlamanız bekleniyor.`
      : 'Vitrin kartınızdan yeni bir talep geldi.',
    audience: 'HİZMET VEREN',
    kicker: 'Vitrin talebi',
    heading: 'Vitrin kartınızdan yeni talep',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        'Bir müşteri doğrudan vitrin kartınızdan talep gönderdi. Bu talep yalnız size ' +
          'iletildi ve yanıtlamanız için teklif kredisi harcanmaz.',
      ),
      spacer(4),
      dataTable([
        row('Talep no', text(data.requestNumber)),
        row('Hizmet', text(data.categoryName)),
        row('Bölge', text(data.locationLabel)),
        row('Aciliyet', urgencyLabel),
        row('Son yanıt zamanı', formatDateTime(data.slaDueAt)),
      ]),
      spacer(24),
      cta('Talebi görüntüle', text(data.leadUrl), 'primary'),
      spacer(20),
      note(
        'Süre içinde yanıt verilmezse müşteriye talebini genel pazara açmak isteyip ' +
          'istemediği sorulur.',
      ),
    ]),
  };
}

/**
 * The window closed — the customer's copy.
 *
 * This message asks a question and does not announce an outcome, because
 * nothing has happened to the request yet: the deadline passing opens nothing,
 * and the customer's own answer is the only thing that can.
 *
 * Both options are stated plainly, including the one where nothing further
 * happens. A message that only offered "open it to everyone" would be a nudge
 * dressed as a choice.
 */
function showcaseLeadBreachedCustomer(
  subject: string,
  fullName: string,
  data: Data,
): EmailDocument {
  const businessName = text(data.businessName);

  return {
    subject,
    preheader: 'Talebinizi diğer hizmet verenlere açmak isteyip istemediğinizi soruyoruz.',
    audience: 'HİZMET ALAN',
    kicker: 'Vitrin talebi',
    heading: 'Yanıt süresi doldu',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        joinNonEmpty(
          [
            businessName
              ? `${businessName}, talebinize taahhüt ettiği süre içinde dönmedi.`
              : 'Talebinize taahhüt edilen süre içinde dönülmedi.',
            'Talebiniz şu anda yalnız bu işletmeye açık ve başka kimseye gönderilmedi.',
          ],
          ' ',
        ) as string,
      ),
      spacer(4),
      dataTable([
        row('Talep no', text(data.requestNumber)),
        row('İşletme', businessName),
        row('Taahhüt edilen süre', text(data.slaLabel)),
        row('Süre bitişi', formatDateTime(data.slaDueAt)),
      ]),
      spacer(20),
      paragraph(
        'İki seçeneğiniz var: talebinizi bölgenizdeki diğer hizmet verenlere açabilir ya da ' +
          'kapalı bırakıp kapatabilirsiniz. Karar tamamen sizin; siz seçmedikçe talebiniz ' +
          'kimseye gönderilmez.',
      ),
      spacer(24),
      cta('Kararımı bildir', text(data.decisionUrl), 'primary'),
      spacer(20),
      note(
        'Talebinizi diğer hizmet verenlere açmayı seçerseniz, yayına alınmadan önce ' +
          'ekibimiz tarafından incelenir.',
      ),
    ]),
  };
}

/**
 * The window closed — the provider's copy.
 *
 * A record, not a sanction. Phase two counts breaches and does nothing else
 * with them; what a repeated breach should cost is a separate product decision
 * and this message deliberately does not pre-empt it by threatening one.
 *
 * It says what happens next honestly: the customer has been asked, and the
 * provider may still answer until they decide.
 */
function showcaseLeadBreachedProvider(
  subject: string,
  fullName: string,
  data: Data,
): EmailDocument {
  return {
    subject,
    preheader: 'Vitrin talebine taahhüt ettiğiniz süre içinde dönülmedi.',
    audience: 'HİZMET VEREN',
    kicker: 'Vitrin talebi',
    heading: 'Yanıt süresi doldu',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        'Vitrin kartınızdan gelen bir talebe, kartınızda taahhüt ettiğiniz süre içinde ' +
          'dönülmedi. Müşteriye talebini diğer hizmet verenlere açmak isteyip istemediği ' +
          'soruldu.',
      ),
      spacer(4),
      dataTable([
        row('Talep no', text(data.requestNumber)),
        row('Hizmet', text(data.categoryName)),
        row('Taahhüt edilen süre', text(data.slaLabel)),
        row('Süre bitişi', formatDateTime(data.slaDueAt)),
      ]),
      spacer(24),
      cta('Talebi görüntüle', text(data.leadUrl), 'primary'),
      spacer(20),
      note(
        'Müşteri kararını verene kadar hâlâ teklif verebilirsiniz. Bu talep için teklif ' +
          'kredisi harcanmaz.',
      ),
    ]),
  };
}

// ────────────── 16b · request.removed → the customer who asked ───────────────

/**
 * A request a report took down, told to the customer who opened it.
 *
 * What it says is fixed: the reason is a label from a customer-facing
 * dictionary chosen by the operator, and the sentence about the offers is a
 * constant because it describes what the removal transaction really did —
 * every live offer on the request is CANCELLED in the same commit, so none of
 * them can be acted on. That sentence is true only on that path, which is why
 * `sendRequestRemoved` is the template's one caller.
 *
 * What it must not say is the reason it is a separate template: no reporter,
 * no report count, no operator's note, no reason *code*. The two links are the
 * two things the customer can actually do next.
 */
function requestRemoved(subject: string, fullName: string, data: Data): EmailDocument {
  const requestNumber = text(data.requestNumber);
  const categoryName = text(data.categoryName);

  return {
    subject,
    preheader: 'Talebiniz platform kurallarına uygunluk incelemesi sonucunda yayından kaldırıldı.',
    audience: 'HİZMET ALAN',
    kicker: 'Yayından kaldırıldı',
    heading: 'Talebiniz yayından kaldırıldı',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        `${removedRequestSubject(requestNumber, categoryName)} platform kurallarına uygunluk ` +
          'incelemesi sonucunda yayından kaldırıldı.',
      ),
      spacer(4),
      dataTable([
        row('Talep', requestNumber),
        row('Kategori', categoryName),
        row('Gerekçe', text(data.reasonLabel)),
      ]),
      spacer(16),
      paragraph(
        'Talep artık hizmet verenlere gösterilmiyor. Mevcut teklifler artık işleme alınamaz.',
      ),
      spacer(8),
      paragraph(
        'Bilgileri düzelterek yeni bir talep açabilir ya da itiraz için destek ekibine ' +
          'yazabilirsiniz.',
      ),
      spacer(24),
      cta('Yeni talep oluştur', text(data.newRequestUrl), 'primary'),
      spacer(12),
      cta('Destek ekibine yaz', text(data.supportUrl), 'ghost'),
    ]),
  };
}

/** The opening subject, narrowed to whatever of the two facts is held. */
function removedRequestSubject(requestNumber: string | null, categoryName: string | null): string {
  return requestNumber && categoryName
    ? `${categoryName} için açtığınız ${requestNumber} numaralı talep`
    : requestNumber
      ? `${requestNumber} numaralı talebiniz`
      : categoryName
        ? `${categoryName} için açtığınız talep`
        : 'Talebiniz';
}

// ───────────────── 16c · request.reported → the support inbox ────────────────

/**
 * A provider reported a request; the support mailbox is told.
 *
 * Four fields and a link, on the NotificationLog principle the support-ticket
 * notices follow: the reporter's free text is not in the message. It is read
 * in the panel, where it sits next to the request it is about and behind the
 * operator's own session, and nowhere else.
 */
function requestReportNewForSupport(subject: string, fullName: string, data: Data): EmailDocument {
  return {
    subject,
    preheader: 'Bir hizmet veren bir talebi bildirdi.',
    audience: 'DESTEK',
    kicker: 'Yeni bildirim',
    heading: 'Yeni talep bildirimi',
    fullName,
    accountUrl: null,
    blocks: compact([
      paragraph('Bir hizmet veren, yayındaki bir talebi platform kurallarına aykırı olabileceği gerekçesiyle bildirdi.'),
      spacer(4),
      dataTable([
        row('Talep', text(data.requestNumber)),
        row('Kategori', text(data.categoryName)),
        row('Bildirim nedeni', text(data.reasonLabel)),
      ]),
      spacer(24),
      cta('Talebi panelde aç', text(data.adminRequestUrl), 'primary'),
    ]),
  };
}

// ─────────────── 16d · request.completed → the customer who asked ────────────

/**
 * The work is done; the customer is invited to rate it.
 *
 * The mail carries what the form will ask about — which request, which
 * business, and until when — and one promise the form keeps: the name, phone
 * and e-mail of the person writing are not shown with the review, and a
 * comment cannot carry contact details. The deadline is a formatted date the
 * call site computed, not a duration, so the message and the form agree on
 * the day.
 */
function reviewInvitation(subject: string, fullName: string, data: Data): EmailDocument {
  const businessName = text(data.businessName) ?? 'Hizmet veren';
  const categoryName = text(data.categoryName) ?? 'talebiniz';

  return {
    subject,
    preheader: 'Tamamlanan işinizin hizmet verenini birkaç saniyede değerlendirin.',
    audience: 'HİZMET ALAN',
    kicker: 'İş tamamlandı',
    heading: 'Hizmet vereni değerlendirin',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        `${businessName} ile ${categoryName} işiniz tamamlandı olarak işaretlendi. ` +
          'Deneyiminizi 1–5 yıldızla değerlendirebilir, dilerseniz kısa bir yorum ' +
          'bırakabilirsiniz.',
      ),
      spacer(4),
      dataTable([
        row('Talep', text(data.requestNumber)),
        row('Hizmet veren', text(data.businessName)),
        row('Son tarih', text(data.windowEndsAt)),
      ]),
      spacer(16),
      paragraph(
        'Yorumunuz herkese açık görünür; adınız, telefonunuz ve e-postanız paylaşılmaz. ' +
          'Yorumda iletişim bilgisi bulunamaz.',
      ),
      spacer(24),
      cta('Değerlendir', text(data.reviewUrl), 'primary'),
    ]),
  };
}

// ────────────── 16e · review.created → the provider who was rated ────────────

/**
 * A review arrived; the provider is told the star count and where to read it.
 *
 * The comment is deliberately not here. It is public on the provider's
 * profile and it is on the list this message links to, and both of those
 * render the current text — a mail is a copy nobody can take down, and a
 * comment an operator removes an hour later would still be in the inbox.
 * The customer's name is not here either: the review is anonymous on the
 * profile, and it is anonymous in the mail.
 */
function reviewReceived(subject: string, fullName: string, data: Data): EmailDocument {
  return {
    subject,
    preheader: 'Tamamladığınız bir iş için yeni bir değerlendirme aldınız.',
    audience: 'HİZMET VEREN',
    kicker: 'Yeni değerlendirme',
    heading: 'Yeni değerlendirme aldınız',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        'Tamamladığınız bir iş için müşteriniz bir değerlendirme bıraktı. Değerlendirmenin ' +
          'tamamını ve puan özetinizi panelinizden görebilirsiniz.',
      ),
      spacer(4),
      dataTable([
        row('Talep', text(data.requestNumber)),
        row('Kategori', text(data.categoryName)),
        row('Puan', starRating(data.rating)),
      ]),
      spacer(16),
      paragraph(
        'Değerlendirmenin platform kurallarına aykırı olduğunu düşünüyorsanız, ' +
          'değerlendirme sayfasından bildirebilirsiniz.',
      ),
      spacer(24),
      cta('Değerlendirmeleri gör', text(data.reviewsUrl), 'primary'),
    ]),
  };
}

/** The star count as a recipient reads it, and null — no row — when there is none. */
function starRating(value: string | null | undefined): string | null {
  const rating = int(value);
  return rating === null ? null : `★ ${rating} / 5`;
}

// ───────────────── 16f · review.reported → the support inbox ─────────────────

/**
 * A provider reported a review; the support mailbox is told.
 *
 * Three fields and a link, on the rule `requestReportNewForSupport` follows:
 * the reporter's note is not in the message. It is read in the panel, next to
 * the review it is about and behind the operator's own session — and so is
 * the review's comment, for the same reason.
 */
function reviewReportNewForSupport(subject: string, fullName: string, data: Data): EmailDocument {
  return {
    subject,
    preheader: 'Bir hizmet veren bir değerlendirmeyi bildirdi.',
    audience: 'DESTEK',
    kicker: 'Yeni bildirim',
    heading: 'Yeni değerlendirme bildirimi',
    fullName,
    accountUrl: null,
    blocks: compact([
      paragraph(
        'Bir hizmet veren, profilindeki bir değerlendirmeyi platform kurallarına aykırı ' +
          'olabileceği gerekçesiyle bildirdi.',
      ),
      spacer(4),
      dataTable([
        row('İşletme', text(data.businessName)),
        row('Talep', text(data.requestNumber)),
        row('Gerekçe', text(data.reasonLabel)),
      ]),
      spacer(24),
      cta('Değerlendirmeyi panelde aç', text(data.adminReviewUrl), 'primary'),
    ]),
  };
}

// ─────────── 16g · review.removed → the customer who wrote it ────────────────

/**
 * An operator took a review, or only its comment, down; the customer is told.
 *
 * `scopeLabel` is what was removed — "Yorumunuz" when the stars stayed on the
 * profile, "Değerlendirmeniz" when the whole review went — and `reasonLabel`
 * is a fixed customer-facing label the operator chose. What it must not say
 * is the reason it is a separate template: no reporter, no operator's note,
 * no reason code. The one link is the one thing the customer can do next.
 */
function reviewRemoved(subject: string, fullName: string, data: Data): EmailDocument {
  const scopeLabel = text(data.scopeLabel) ?? 'Değerlendirmeniz';

  return {
    subject,
    preheader: `${scopeLabel} platform kurallarına uygunluk incelemesi sonucunda kaldırıldı.`,
    audience: 'HİZMET ALAN',
    kicker: 'Kaldırıldı',
    heading: `${scopeLabel} kaldırıldı`,
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        `${scopeLabel} platform kurallarına uygunluk incelemesi sonucunda kaldırıldı ve ` +
          'artık hizmet verenin profilinde gösterilmiyor.',
      ),
      spacer(4),
      dataTable([
        row('Talep', text(data.requestNumber)),
        row('Gerekçe', text(data.reasonLabel)),
      ]),
      spacer(16),
      paragraph('Bu karara itiraz etmek isterseniz destek ekibine yazabilirsiniz.'),
      spacer(24),
      cta('Destek ekibine yaz', text(data.supportUrl), 'primary'),
    ]),
  };
}

// ────────────────────────── 17-21 · support tickets ──────────────────────────

/**
 * What a ticket status is called in a message.
 *
 * The same table the two operator-facing and three customer-facing messages
 * read, and the reason it lives here rather than at the call site is the rule
 * every other coded value in this file follows: `data.status` carries the
 * storage code the column holds — `IN_PROGRESS` — and a recipient must never be
 * shown one. A code this build does not know resolves to null, which makes the
 * row disappear exactly like a missing value rather than printing the code.
 *
 * The wording is the customer-facing wording for this message set. It is
 * deliberately warmer than the panel's own badges ("İşlemde", "Çözüldü"): an
 * inbox has none of the surrounding screen to explain a two-word label.
 */
const SUPPORT_TICKET_STATUS_LABELS: Record<string, string> = {
  OPEN: 'Açık',
  IN_PROGRESS: 'İnceleniyor',
  RESOLVED: 'Çözümlendi',
  CLOSED: 'Kapatıldı',
};

function supportStatusLabel(value: string | null | undefined): string | null {
  const code = text(value);
  return code ? (SUPPORT_TICKET_STATUS_LABELS[code] ?? null) : null;
}

/** How much of a message body a notification quotes. The ticket itself has all of it. */
const SUPPORT_MESSAGE_EXCERPT_LENGTH = 240;

function supportExcerpt(data: Data): string | null {
  return truncate(text(data.messageExcerpt), SUPPORT_MESSAGE_EXCERPT_LENGTH);
}

/**
 * The quoted message, as a labelled section, or nothing at all.
 *
 * Returned as a list so both halves vanish together: a section label with no
 * section under it is worse than no label, and `compact` cannot know the two
 * belong to each other.
 */
function quotedMessage(label: string, excerpt: string | null): (EmailBlock | null)[] {
  return excerpt ? [sectionLabel(label), paragraph(excerpt)] : [];
}

/** The ticket's identity rows, shared by every one of these messages. */
function ticketRows(data: Data): (EmailDataRow | null)[] {
  return [
    row('Talep referansı', text(data.ticketReference)),
    row('Konu', text(data.ticketSubject)),
  ];
}

/**
 * Who is waiting, on the four messages that go to the support mailbox.
 *
 * The desk comes first and is spelled out — "Hizmet alan" or "Hizmet veren" —
 * because it is the fact that decides which screen an operator opens and which
 * rules apply to the answer. It is printed from `requesterRoleLabel`, which the
 * payload builder fills from the ticket's own snapshot; this template never
 * infers it from which of the four it happens to be, so a message and the
 * ticket behind it cannot come to disagree.
 *
 * Never rendered on a message to the person who opened the ticket. Those go to
 * somebody who knows their own name and address, and repeating them there only
 * widens what a forwarded or leaked message says.
 */
function requesterRows(data: Data): (EmailDataRow | null)[] {
  return [
    row('Talep sahibi', text(data.requesterRoleLabel)),
    row('Ad', text(data.requesterName)),
    row('E-posta', text(data.requesterEmail)),
  ];
}

/**
 * 17 · support.ticket_created — the customer's copy.
 *
 * It confirms that the ticket exists and shows what was said, and it stops
 * there. There is no answering time in it and no service level, because this
 * product measures neither and a receipt is a poor place to invent one.
 */
function supportTicketCreated(subject: string, fullName: string, data: Data): EmailDocument {
  return {
    subject,
    preheader: 'Destek talebinizi aldık; yanıtlarımızı bu talep üzerinden ileteceğiz.',
    audience: 'HİZMET ALAN',
    kicker: 'Destek talebi',
    heading: 'Destek talebiniz alındı',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        'Destek talebinizi aldık. Yanıtlarımızı ve talebinizle ilgili her gelişmeyi bu talep ' +
          'üzerinden ileteceğiz.',
      ),
      spacer(4),
      dataTable([
        ...ticketRows(data),
        row('Durum', supportStatusLabel(data.status)),
        row('Oluşturulma', formatDateTime(data.createdAt)),
      ]),
      spacer(22),
      ...quotedMessage('Mesajınız', supportExcerpt(data)),
      spacer(24),
      cta('Talebi görüntüle', text(data.ticketUrl), 'primary'),
      spacer(20),
      note(
        'Eklemek istediğiniz bir şey olursa bu e-postayı yanıtlayabilir veya talebi panelinizden ' +
          'açarak yazabilirsiniz.',
      ),
    ]),
  };
}

/**
 * 18 · support.ticket_created — the operator's copy.
 *
 * The one message in this file whose recipient is a mailbox rather than a
 * person, which is why it carries the customer's name and address: an operator
 * opening the queue sees both on the ticket already, and a notification that
 * withheld them would just be a link somebody has to click to find out who is
 * waiting. Nothing about the account beyond those two — no phone number, no
 * request history, no payment fact — reaches this message.
 */
function supportTicketNewForSupport(subject: string, fullName: string, data: Data): EmailDocument {
  return {
    subject,
    preheader: 'Bir hizmet alan yeni bir destek talebi açtı.',
    audience: 'DESTEK',
    kicker: 'Yeni talep',
    heading: 'Yeni destek talebi',
    fullName,
    accountUrl: null,
    blocks: compact([
      paragraph('Bir hizmet alan yeni bir destek talebi açtı.'),
      spacer(4),
      dataTable([
        ...ticketRows(data),
        ...requesterRows(data),
        row('Durum', supportStatusLabel(data.status)),
        row('Oluşturulma', formatDateTime(data.createdAt)),
      ]),
      spacer(22),
      ...quotedMessage('İlk mesaj', supportExcerpt(data)),
      spacer(24),
      cta('Talebi panelde aç', text(data.ticketUrl), 'primary'),
    ]),
  };
}

/** 19 · support.customer_message — the operator's copy. */
function supportTicketCustomerReply(subject: string, fullName: string, data: Data): EmailDocument {
  return {
    subject,
    preheader: 'Açık bir destek talebine hizmet alan yanıtı geldi.',
    audience: 'DESTEK',
    kicker: 'Hizmet alan yanıtı',
    heading: 'Destek talebine yeni mesaj',
    fullName,
    accountUrl: null,
    blocks: compact([
      paragraph('Bir hizmet alan kendi destek talebine yeni bir mesaj ekledi.'),
      spacer(4),
      dataTable([
        ...ticketRows(data),
        ...requesterRows(data),
        row('Durum', supportStatusLabel(data.status)),
        row('Mesaj zamanı', formatDateTime(data.messageAt)),
      ]),
      spacer(22),
      ...quotedMessage('Mesaj', supportExcerpt(data)),
      spacer(24),
      cta('Talebi panelde aç', text(data.ticketUrl), 'primary'),
    ]),
  };
}

/**
 * 20 · support.admin_message — the customer's copy.
 *
 * What is absent is the whole point. The answer itself is quoted, because the
 * customer can read it on their own ticket screen anyway; who wrote it is not,
 * and nor is anything the operator wrote for the company rather than for the
 * customer. This template reads exactly four fields, and none of them can carry
 * an operator's identity.
 */
function supportTicketAdminReply(subject: string, fullName: string, data: Data): EmailDocument {
  return {
    subject,
    preheader: 'Destek talebinize yeni bir yanıt eklendi.',
    audience: 'HİZMET ALAN',
    kicker: 'Yanıt',
    heading: 'Destek talebinize yanıt verdik',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph('Destek ekibimiz talebinize yanıt verdi.'),
      spacer(4),
      dataTable([
        ...ticketRows(data),
        row('Durum', supportStatusLabel(data.status)),
        row('Yanıt zamanı', formatDateTime(data.messageAt)),
      ]),
      spacer(22),
      ...quotedMessage('Yanıtımız', supportExcerpt(data)),
      spacer(24),
      cta('Talebi görüntüle', text(data.ticketUrl), 'primary'),
      spacer(20),
      note('Yanıtınızı bu e-postayı yanıtlayarak veya talebi panelinizden açarak iletebilirsiniz.'),
    ]),
  };
}

/**
 * 21 · support.status_changed — the customer's copy.
 *
 * Both ends of the move are printed when both are known, because "çözümlendi"
 * on its own does not tell the reader whether anything actually changed. The
 * operational reason a ticket moved is never here: an operator's reasoning is
 * internal, and the customer is being told a fact about their own ticket.
 */
function supportTicketStatusChanged(subject: string, fullName: string, data: Data): EmailDocument {
  const to = supportStatusLabel(data.status);
  const closed = text(data.status) === 'CLOSED';

  return {
    subject,
    preheader: to
      ? `Destek talebinizin durumu "${to}" olarak güncellendi.`
      : 'Destek talebinizin durumu güncellendi.',
    audience: 'HİZMET ALAN',
    kicker: 'Durum güncellemesi',
    heading: 'Destek talebinizin durumu değişti',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        to
          ? `Destek talebiniz "${to}" durumuna alındı.`
          : 'Destek talebinizin durumu güncellendi.',
      ),
      spacer(4),
      dataTable([
        ...ticketRows(data),
        row('Önceki durum', supportStatusLabel(data.fromStatus)),
        row('Yeni durum', to),
        row('Güncelleme zamanı', formatDateTime(data.changedAt)),
      ]),
      spacer(24),
      cta('Talebi görüntüle', text(data.ticketUrl), 'primary'),
      spacer(20),
      note(
        closed
          ? 'Kapatılan bir talebe yeni mesaj eklenemez. Aynı konu sürüyorsa panelinizden yeni bir ' +
              'talep açabilirsiniz.'
          : 'Talebinizle ilgili her gelişmeyi bu talep üzerinden ileteceğiz.',
      ),
    ]),
  };
}

/**
 * 22 · support.ticket_created — the hizmet veren's copy.
 *
 * The hizmet alan's version of this message with two differences, and they are
 * the reason it is its own template rather than a parameter. The audience strip
 * reads HİZMET VEREN, so a forwarded message says which panel it belongs to.
 * And the note at the bottom points at the hizmet veren panel rather than at a
 * talep screen a hizmet veren has no access to.
 *
 * What it does *not* differ in is anything about the ticket itself: same
 * reference, same subject, same quoted opening message, same absence of a
 * promised answering time this product does not measure.
 */
function supportTicketProviderCreated(subject: string, fullName: string, data: Data): EmailDocument {
  return {
    subject,
    preheader: 'Destek talebinizi aldık; yanıtlarımızı bu talep üzerinden ileteceğiz.',
    audience: 'HİZMET VEREN',
    kicker: 'Destek talebi',
    heading: 'Destek talebiniz alındı',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        'Destek talebinizi aldık. Yanıtlarımızı ve talebinizle ilgili her gelişmeyi bu talep ' +
          'üzerinden ileteceğiz.',
      ),
      spacer(4),
      dataTable([
        ...ticketRows(data),
        row('Durum', supportStatusLabel(data.status)),
        row('Oluşturulma', formatDateTime(data.createdAt)),
      ]),
      spacer(22),
      ...quotedMessage('Mesajınız', supportExcerpt(data)),
      spacer(24),
      cta('Talebi görüntüle', text(data.ticketUrl), 'primary'),
      spacer(20),
      note(
        'Eklemek istediğiniz bir şey olursa bu e-postayı yanıtlayabilir veya talebi hizmet veren ' +
          'panelinizden açarak yazabilirsiniz.',
      ),
    ]),
  };
}

/**
 * 23 · support.ticket_created — the operator's copy, hizmet veren edition.
 *
 * Separate from the hizmet alan's inbox copy for one operational reason: the
 * two are triaged differently, and an operator sorting a shared mailbox by
 * subject should be able to see which desk a ticket came from without opening
 * it. The body says it too, in the `requesterRows` block, so a message read out
 * of order still says who is waiting.
 */
function supportTicketProviderNewForSupport(
  subject: string,
  fullName: string,
  data: Data,
): EmailDocument {
  return {
    subject,
    preheader: 'Bir hizmet veren yeni bir destek talebi açtı.',
    audience: 'DESTEK',
    kicker: 'Yeni talep',
    heading: 'Yeni destek talebi (hizmet veren)',
    fullName,
    accountUrl: null,
    blocks: compact([
      paragraph('Bir hizmet veren yeni bir destek talebi açtı.'),
      spacer(4),
      dataTable([
        ...ticketRows(data),
        ...requesterRows(data),
        row('Durum', supportStatusLabel(data.status)),
        row('Oluşturulma', formatDateTime(data.createdAt)),
      ]),
      spacer(22),
      ...quotedMessage('İlk mesaj', supportExcerpt(data)),
      spacer(24),
      cta('Talebi panelde aç', text(data.ticketUrl), 'primary'),
    ]),
  };
}

/** 24 · support.requester_message — the operator's copy, hizmet veren edition. */
function supportTicketProviderReply(subject: string, fullName: string, data: Data): EmailDocument {
  return {
    subject,
    preheader: 'Açık bir destek talebine hizmet veren yanıtı geldi.',
    audience: 'DESTEK',
    kicker: 'Hizmet veren yanıtı',
    heading: 'Destek talebine yeni mesaj',
    fullName,
    accountUrl: null,
    blocks: compact([
      paragraph('Bir hizmet veren kendi destek talebine yeni bir mesaj ekledi.'),
      spacer(4),
      dataTable([
        ...ticketRows(data),
        ...requesterRows(data),
        row('Durum', supportStatusLabel(data.status)),
        row('Mesaj zamanı', formatDateTime(data.messageAt)),
      ]),
      spacer(22),
      ...quotedMessage('Mesaj', supportExcerpt(data)),
      spacer(24),
      cta('Talebi panelde aç', text(data.ticketUrl), 'primary'),
    ]),
  };
}

/**
 * 25 · support.admin_message — the hizmet veren's copy.
 *
 * What is absent is the whole point, exactly as it is on the hizmet alan's
 * version: the answer is quoted, and who wrote it is not. This template reads
 * four fields and none of them can carry an operator's identity — the payload
 * builder never loads one.
 */
function supportTicketProviderAdminReply(
  subject: string,
  fullName: string,
  data: Data,
): EmailDocument {
  return {
    subject,
    preheader: 'Destek talebinize yeni bir yanıt eklendi.',
    audience: 'HİZMET VEREN',
    kicker: 'Yanıt',
    heading: 'Destek talebinize yanıt verdik',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph('Destek ekibimiz talebinize yanıt verdi.'),
      spacer(4),
      dataTable([
        ...ticketRows(data),
        row('Durum', supportStatusLabel(data.status)),
        row('Yanıt zamanı', formatDateTime(data.messageAt)),
      ]),
      spacer(22),
      ...quotedMessage('Yanıtımız', supportExcerpt(data)),
      spacer(24),
      cta('Talebi görüntüle', text(data.ticketUrl), 'primary'),
      spacer(20),
      note(
        'Yanıtınızı bu e-postayı yanıtlayarak veya talebi hizmet veren panelinizden açarak ' +
          'iletebilirsiniz.',
      ),
    ]),
  };
}

/** 26 · support.status_changed — the hizmet veren's copy. */
function supportTicketProviderStatusChanged(
  subject: string,
  fullName: string,
  data: Data,
): EmailDocument {
  const to = supportStatusLabel(data.status);
  const closed = text(data.status) === 'CLOSED';

  return {
    subject,
    preheader: to
      ? `Destek talebinizin durumu "${to}" olarak güncellendi.`
      : 'Destek talebinizin durumu güncellendi.',
    audience: 'HİZMET VEREN',
    kicker: 'Durum güncellemesi',
    heading: 'Destek talebinizin durumu değişti',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        to ? `Destek talebiniz "${to}" durumuna alındı.` : 'Destek talebinizin durumu güncellendi.',
      ),
      spacer(4),
      dataTable([
        ...ticketRows(data),
        row('Önceki durum', supportStatusLabel(data.fromStatus)),
        row('Yeni durum', to),
        row('Güncelleme zamanı', formatDateTime(data.changedAt)),
      ]),
      spacer(24),
      cta('Talebi görüntüle', text(data.ticketUrl), 'primary'),
      spacer(20),
      note(
        closed
          ? 'Kapatılan bir talebe yeni mesaj eklenemez. Aynı konu sürüyorsa hizmet veren ' +
              'panelinizden yeni bir talep açabilirsiniz.'
          : 'Talebinizle ilgili her gelişmeyi bu talep üzerinden ileteceğiz.',
      ),
    ]),
  };
}

// ───────────────────────────── vitrin, phase three ───────────────────────────

/**
 * The package was paid for.
 *
 * What is stated is what the provider now holds: a right to publish one card
 * for so many days, usable until a date. The only figure is the package's own
 * price, taken from the purchase snapshot — never anything about what the
 * provider charges their customers, which is a different number in a
 * different place. Nothing from the payment provider travels either: no order
 * id, no correlation token, no store, no mode.
 *
 * The call to action is the next thing to do rather than a receipt: the right
 * is spent by a card, and the provider may not have one yet.
 */
function showcasePackagePaymentSucceeded(
  subject: string,
  fullName: string,
  data: Data,
): EmailDocument {
  const packageName = text(data.packageName);
  const durationDays = int(data.durationDays);
  const expiresAt = formatDate(data.entitlementExpiresAt);

  return {
    subject,
    preheader: expiresAt
      ? `Yayın hakkınız ${expiresAt} tarihine kadar kullanılabilir.`
      : 'Vitrin paketiniz için ödemeniz alındı.',
    audience: 'HİZMET VEREN',
    kicker: 'Vitrin',
    heading: 'Vitrin paketiniz hazır',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        joinNonEmpty(
          [
            packageName ? `${packageName} paketi için ödemeniz alındı.` : 'Ödemeniz alındı.',
            'Kartınız onaylandığında yayın süresi başlar; hakkınızı aşağıdaki tarihe kadar ' +
              'kullanabilirsiniz.',
          ],
          ' ',
        ) as string,
      ),
      spacer(4),
      dataTable([
        row('Paket', packageName),
        row('Yayın süresi', durationDays ? `${durationDays} gün` : null),
        row('Paket bedeli', formatMoneyMinorIn(int(data.priceAmountMinor), text(data.currency))),
        row('Hakkın son kullanım tarihi', expiresAt),
        row('Ödeme tarihi', formatDateTime(data.paidAt)),
      ]),
      spacer(24),
      cta('Kartını oluştur', text(data.createCardUrl), 'primary'),
      spacer(20),
      note(
        'Yayın süresi kartınız onaylanıp yayına girdiği anda başlar; onay için beklenen ' +
          'süre haktan düşülmez.',
      ),
    ]),
  };
}

/**
 * The payment did not complete.
 *
 * Deliberately thin. It says that nothing was charged and nothing was granted,
 * and it says nothing about *why* — no card detail, no decline code, no
 * provider message — because none of that is this platform's to relay and
 * most of it is the buyer's bank's business. The one link goes back to the
 * shop, where a fresh checkout can be opened.
 */
function showcasePackagePaymentFailed(
  subject: string,
  fullName: string,
  data: Data,
): EmailDocument {
  const packageName = text(data.packageName);

  return {
    subject,
    preheader: 'Ödeme tamamlanmadı; paket hesabınıza tanımlanmadı.',
    audience: 'HİZMET VEREN',
    kicker: 'Vitrin',
    heading: 'Vitrin paketi ödemesi tamamlanmadı',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        (packageName ? `${packageName} paketi için başlattığınız ödeme` : 'Başlattığınız ödeme') +
          ' tamamlanamadı. Hesabınızdan bir tahsilat yapılmadı ve paket tanımlanmadı.',
      ),
      spacer(4),
      dataTable([
        row('Paket', packageName),
        row('Paket bedeli', formatMoneyMinorIn(int(data.priceAmountMinor), text(data.currency))),
        row('İşlem tarihi', formatDateTime(data.attemptedAt)),
      ]),
      spacer(24),
      cta('Paketlere dön', text(data.packagesUrl), 'primary'),
      spacer(20),
      note(
        'Dilediğiniz zaman paketlerden yeni bir ödeme başlatabilirsiniz. Sorun sürerse ' +
          'destek ekibimize yazabilirsiniz.',
      ),
    ]),
  };
}

/**
 * Approved and on the air, as one message.
 *
 * The approval and the run are one transaction, so they are one message: a
 * provider who is told "approved" and then, a second later, "live" learns to
 * open only the first. The run's dates are here because they are the
 * provider's own information and the one thing they need to plan a renewal.
 *
 * `revision` distinguishes a first publication from an approved edit to a card
 * that was already live — the same facts, one sentence apart.
 */
function showcaseCardApprovedLive(subject: string, fullName: string, data: Data): EmailDocument {
  const cardTitle = text(data.cardTitle);
  const revision = text(data.revision) === 'true';

  return {
    subject,
    preheader: cardTitle
      ? `${cardTitle} kartınız onaylandı ve ana sayfada yayında.`
      : 'Vitrin kartınız onaylandı ve ana sayfada yayında.',
    audience: 'HİZMET VEREN',
    kicker: 'Vitrin',
    heading: revision ? 'Güncellemeniz onaylandı ve yayında' : 'Kartınız onaylandı ve yayında',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        revision
          ? 'Kartınızda yaptığınız değişiklik incelendi ve onaylandı. Yayındaki kartınız artık ' +
              'onaylanan metni gösteriyor; yayın süresi değişmedi.'
          : 'Kartınız incelendi ve onaylandı. Aynı anda yayına alındı: seçtiğiniz bölgelerde ' +
              'arayan müşterilere gösterilmeye başladı.',
      ),
      spacer(4),
      dataTable([
        row('Kart', cardTitle),
        row('Paket', text(data.packageName)),
        row('Bölgeler', text(data.areaSummary)),
        row('Başlangıç', formatDateTime(data.startAt)),
        row('Bitiş', formatDateTime(data.endAt)),
      ]),
      spacer(24),
      cta('Kartını görüntüle', text(data.cardUrl), 'primary'),
      spacer(20),
      note(
        'Kartınızdan gelen talepler yalnız size iletilir ve bu talepler için teklif kredisi ' +
          'harcanmaz.',
      ),
    ]),
  };
}

/**
 * Approved, with nothing on the air.
 *
 * Sent only when the approval did not publish anything — an edit approved on a
 * card whose run has ended. It says the text is approved and stops there; what
 * puts the card back on the air is a package, and the link goes to where one
 * is bought.
 */
function showcaseCardApproved(subject: string, fullName: string, data: Data): EmailDocument {
  const cardTitle = text(data.cardTitle);

  return {
    subject,
    preheader: cardTitle
      ? `${cardTitle} kartınız onaylandı; yayına almak için bir paket seçin.`
      : 'Vitrin kartınız onaylandı; yayına almak için bir paket seçin.',
    audience: 'HİZMET VEREN',
    kicker: 'Vitrin',
    heading: 'Vitrin kartınız onaylandı',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        'Kartınız incelendi ve onaylandı. Şu anda yayında değil: yayına almak için vitrin ' +
          'merkezinizden bir paket seçmeniz yeterli.',
      ),
      spacer(4),
      dataTable([row('Kart', cardTitle), row('Onay tarihi', formatDateTime(data.approvedAt))]),
      spacer(24),
      cta('Vitrin merkezine git', text(data.showcaseUrl), 'primary'),
      spacer(20),
      note('Paket seçtiğiniz anda kartınız yayına girer; yeni bir inceleme gerekmez.'),
    ]),
  };
}

/**
 * The run is ending — seven days out, then three.
 *
 * Two templates and one renderer, because the message is the same with a
 * different number and a different length: the seven-day notice explains, the
 * three-day one reminds. The end date is the *current* one, so a run whose
 * clock was stopped by the platform and given back is told its real end.
 */
function showcasePlacementEnding(
  subject: string,
  fullName: string,
  data: Data,
  daysLeft: 7 | 3,
): EmailDocument {
  const cardTitle = text(data.cardTitle);
  const endAt = formatDateTime(data.endAt);

  return {
    subject,
    preheader: endAt
      ? `Yayın ${endAt} tarihinde sona eriyor.`
      : `Vitrin yayınınızın bitmesine ${daysLeft} gün kaldı.`,
    audience: 'HİZMET VEREN',
    kicker: 'Vitrin',
    heading:
      daysLeft === 7 ? 'Vitrin yayınınızın bitmesine 7 gün kaldı' : 'Vitrin yayınınız 3 gün içinde bitiyor',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        daysLeft === 7
          ? (cardTitle ? `${cardTitle} kartınızın` : 'Vitrin kartınızın') +
              ' yayın süresi bir hafta içinde doluyor. Süre bittiğinde kart ana sayfadan ' +
              'kalkar ve karttan yeni talep gelmez. Kesintisiz devam etmek için şimdiden yeni ' +
              'bir paket seçebilirsiniz.'
          : (cardTitle ? `${cardTitle} kartınızın` : 'Vitrin kartınızın') +
              ' yayını 3 gün içinde bitiyor. Devam etmek için yeni bir paket seçin.',
      ),
      spacer(4),
      dataTable([row('Kart', cardTitle), row('Bitiş', endAt)]),
      spacer(24),
      cta('Yeniden yayınla', text(data.packagesUrl), 'primary'),
      cta('Vitrin merkezi', text(data.showcaseUrl), 'ghost'),
      spacer(20),
      note('Yeni paket, mevcut yayın bittikten sonra kartınız onaylı kaldığı sürece hemen kullanılabilir.'),
    ]),
  };
}

/** The run ended. The card is off the air; the way back is a package. */
function showcasePlacementExpired(subject: string, fullName: string, data: Data): EmailDocument {
  const cardTitle = text(data.cardTitle);

  return {
    subject,
    preheader: cardTitle
      ? `${cardTitle} kartınız artık yayında değil.`
      : 'Vitrin kartınız artık yayında değil.',
    audience: 'HİZMET VEREN',
    kicker: 'Vitrin',
    heading: 'Vitrin yayınınız sona erdi',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        (cardTitle ? `${cardTitle} kartınızın` : 'Vitrin kartınızın') +
          ' yayın süresi doldu. Kart artık ana sayfada ve vitrin sayfalarında gösterilmiyor; ' +
          'kartınız ve daha önce gelen talepleriniz panelinizde duruyor.',
      ),
      spacer(4),
      dataTable([row('Kart', cardTitle), row('Yayın bitişi', formatDateTime(data.endAt))]),
      spacer(24),
      cta('Yeniden yayınla', text(data.packagesUrl), 'primary'),
      cta('Vitrin merkezi', text(data.showcaseUrl), 'ghost'),
      spacer(20),
      note('Yeni bir paket seçtiğinizde onaylı kartınız yeniden incelenmeden yayına girer.'),
    ]),
  };
}

// ──────────────────────────────── block helpers ──────────────────────────────

function paragraph(textValue: string): EmailBlock {
  return { kind: 'paragraph', text: textValue };
}

function note(textValue: string): EmailBlock {
  return { kind: 'note', text: textValue };
}

function sectionLabel(textValue: string): EmailBlock {
  return { kind: 'sectionLabel', text: textValue };
}

function spacer(height: number): EmailBlock {
  return { kind: 'spacer', height };
}

/** Null when there is no URL, which removes the button rather than breaking it. */
function cta(
  label: string,
  url: string | null | undefined,
  variant: 'primary' | 'ghost',
): EmailBlock | null {
  return url ? { kind: 'cta', label, url, variant } : null;
}

/** Null when every row was dropped, which removes the empty table too. */
function dataTable(rows: (EmailDataRow | null)[]): EmailBlock | null {
  const present = rows.filter((entry): entry is EmailDataRow => entry !== null);
  return present.length > 0 ? { kind: 'dataTable', rows: present } : null;
}

function row(label: string, value: string | null | undefined): EmailDataRow | null {
  const trimmed = value?.trim();
  return trimmed ? { label, value: trimmed } : null;
}

/**
 * Drops the nulls, and then drops a spacer that no longer separates anything.
 *
 * Without the second half, removing a call to action would leave its 24px and
 * 20px gaps stacked into a 44px hole where the button used to be.
 */
function compact(blocks: (EmailBlock | null)[]): EmailBlock[] {
  const present = blocks.filter((block): block is EmailBlock => block !== null);
  const result: EmailBlock[] = [];

  for (const block of present) {
    const isSpacer = block.kind === 'spacer';
    const previousIsSpacer = result.at(-1)?.kind === 'spacer';

    if (isSpacer && (result.length === 0 || previousIsSpacer)) {
      continue;
    }

    result.push(block);
  }

  while (result.at(-1)?.kind === 'spacer') {
    result.pop();
  }

  return result;
}

// ──────────────────────────────── data helpers ───────────────────────────────

function text(value: string | null | undefined): string | null {
  return nonEmpty(value);
}

function int(value: string | null | undefined): number | null {
  const raw = nonEmpty(value);
  if (raw === null) {
    return null;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The customer's stated timing: the date they chose, the urgency they picked,
 * or both. Null when they gave neither, which drops the row.
 *
 * The urgency goes through the label table rather than into the message
 * verbatim. `data.urgency` carries the storage code the request form wrote —
 * `THIS_WEEK` — and a recipient must never be shown one; an unknown code
 * resolves to null and simply disappears, exactly like a missing date. Because
 * both halves can vanish, the separator only ever appears between two real
 * values: no dangling "·", no empty parentheses, no "undefined".
 */
function preferredTime(data: Data): string | null {
  return joinNonEmpty(
    [formatDateRange(data.preferredDate, data.preferredDateEnd), urgencyLabel(data.urgency)],
    ' · ',
  );
}

function joinNonEmpty(parts: (string | null)[], separator: string): string | null {
  const present = parts.filter((part): part is string => Boolean(part && part.trim()));
  return present.length > 0 ? present.join(separator) : null;
}

function withSuffix(base: string, suffix: string | null): string {
  return suffix ? `${base} — ${suffix}` : base;
}
