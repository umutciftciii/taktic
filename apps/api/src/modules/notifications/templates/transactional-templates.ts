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
  formatDateTime,
  formatLocation,
  formatMoneyMinor,
  nonEmpty,
  truncate,
  urgencyLabel,
} from './format';

/**
 * The twelve transactional messages, as data.
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
 * - `provider_rating`, `provider_job_count` (07) — there is no rating system.
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

/** The twelve template identifiers, in handoff order. */
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
] as const;

export type TransactionalEmailTemplate = (typeof TRANSACTIONAL_EMAIL_TEMPLATES)[number];

export function isTransactionalEmailTemplate(value: string): value is TransactionalEmailTemplate {
  return (TRANSACTIONAL_EMAIL_TEMPLATES as readonly string[]).includes(value);
}

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
    case 'credit-refunded':
      return withSuffix('Krediniz iade edildi', formatCredits(int(data.refundedCredits)));
  }
}

export function renderTransactionalEmail(
  template: TransactionalEmailTemplate,
  message: NotificationMessage,
): RenderedDocument {
  return renderDocument(buildDocument(template, message));
}

/** Exposed for tests, which assert on the block model as well as the markup. */
export function buildDocument(
  template: TransactionalEmailTemplate,
  message: NotificationMessage,
): EmailDocument {
  const data = message.data ?? {};
  const fullName = text(data.fullName) ?? 'Kullanıcı';
  const subject = message.subject;

  switch (template) {
    case 'password-reset':
      return passwordReset(subject, fullName, data, message.actionUrl);
    case 'email-verification':
      return emailVerification(subject, fullName, data, message.actionUrl);
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
  return {
    subject,
    preheader: 'Talebiniz onaylandığında uzmanlara iletilecek.',
    audience: 'HİZMET ALAN',
    kicker: 'Talep alındı',
    heading: 'Talebiniz inceleniyor',
    fullName,
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(
        'Talebinizi aldık. Yayına almadan önce kısa bir kontrolden geçiriyoruz.',
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
      // The real policy, in place of the handoff's unmeasured tip: a delivered
      // offer that simply was not chosen is not refundable.
      note(
        'Teklifiniz müşteriye ulaştığı için bu teklif kredisi iade edilmez. Kredi geçmişinizi ' +
          'panelinizden görebilirsiniz.',
      ),
    ]),
  };
}

// ───────────────────────────── 12 · credit.refunded ──────────────────────────

function creditRefunded(subject: string, fullName: string, data: Data): EmailDocument {
  const refunded = int(data.refundedCredits);
  const requestNumber = text(data.requestNumber);
  const reason = text(data.refundReason);

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
        row('Önceki bakiye', formatCredits(int(data.previousBalance))),
        row('Güncel bakiye', formatCredits(int(data.currentBalance))),
      ]),
      spacer(24),
      cta('Bakiyemi gör', text(data.creditsUrl), 'ghost'),
      spacer(20),
      note('İade işlemleri kredi geçmişinizde iade kaydı olarak listelenir.'),
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
  return joinNonEmpty([formatDate(data.preferredDate), urgencyLabel(data.urgency)], ' · ');
}

function joinNonEmpty(parts: (string | null)[], separator: string): string | null {
  const present = parts.filter((part): part is string => Boolean(part && part.trim()));
  return present.length > 0 ? present.join(separator) : null;
}

function withSuffix(base: string, suffix: string | null): string {
  return suffix ? `${base} — ${suffix}` : base;
}
