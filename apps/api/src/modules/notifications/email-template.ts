import { NotificationMessage } from './notification.port';

/**
 * Renders the plain-text and HTML bodies a delivering transport sends.
 *
 * Only transactional mail exists here: an activation link, a claim link, and
 * the one reminder an approved request earns. There is no marketing block, no
 * unsubscribe funnel and no tracking pixel — the wording below is the whole
 * message, and both bodies say the same thing so a text-only client is not
 * shown a degraded version.
 *
 * Every interpolated value is escaped for the HTML body. The values come from
 * customer- and applicant-supplied fields (a business name, a display name), so
 * treating them as markup would be a stored-XSS sink in whatever client renders
 * the mail.
 */
export type RenderedEmail = {
  text: string;
  html: string;
};

export function renderEmail(message: NotificationMessage): RenderedEmail {
  const paragraphs = bodyParagraphs(message);
  const action = actionFor(message);

  return {
    text: renderText(paragraphs, action),
    html: renderHtml(message.subject, paragraphs, action),
  };
}

type EmailAction = { label: string; url: string } | null;

function bodyParagraphs(message: NotificationMessage): string[] {
  const data = message.data ?? {};

  switch (message.template) {
    case 'customer-activation':
      return [
        greeting(data.name),
        'TakTic hesabınızı etkinleştirmek için aşağıdaki bağlantıyı kullanın.',
        expiryLine(data.expiresAt, 'Bağlantı'),
        'Bu isteği siz yapmadıysanız bu e-postayı yok sayabilirsiniz.',
      ].filter(isPresent);

    case 'provider-claim':
      return [
        greeting(data.businessName),
        'TakTic üzerinde bu işletme adına oluşturulmuş bir hizmet veren başvurusu bulunuyor. ' +
          'Başvuruyu kendi hesabınıza bağlamak için aşağıdaki bağlantıyı kullanın.',
        'Bu bağlantı yalnızca başvurunun sahipliğini doğrular; başvurunun değerlendirme sonucu ' +
          'hakkında bir anlam taşımaz.',
        expiryLine(data.expiresAt, 'Bağlantı'),
        'Böyle bir başvuru yaptırmadıysanız bu e-postayı yok sayabilirsiniz.',
      ].filter(isPresent);

    case 'request-expiring':
      return [
        'Merhaba,',
        requestLine(data.requestNumber, data.categoryName),
        remainingLine(data.remainingDays, data.openDays),
        expiryLine(data.expiresAt, 'Talep'),
        'Talebinizi TakTic üzerinden görüntüleyebilir veya güncelleyebilirsiniz.',
      ].filter(isPresent);

    default:
      return ['Merhaba,'];
  }
}

function actionFor(message: NotificationMessage): EmailAction {
  if (!message.actionUrl) {
    return null;
  }

  return {
    label: message.template === 'provider-claim' ? 'Başvuruyu hesabıma bağla' : 'Hesabımı etkinleştir',
    url: message.actionUrl,
  };
}

function greeting(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? `Merhaba ${trimmed},` : 'Merhaba,';
}

function requestLine(
  requestNumber: string | null | undefined,
  categoryName: string | null | undefined,
): string {
  const number = requestNumber?.trim();
  const category = categoryName?.trim();

  if (number && category) {
    return `${category} kategorisindeki ${number} numaralı talebiniz hâlâ açık.`;
  }

  return number ? `${number} numaralı talebiniz hâlâ açık.` : 'Talebiniz hâlâ açık.';
}

/**
 * States that the window is closing and stops there: it must not claim the
 * request was verified, and it must not suggest that offers are on their way.
 */
function remainingLine(
  remainingDays: string | null | undefined,
  openDays: string | null | undefined,
): string | null {
  const remaining = remainingDays?.trim();
  const open = openDays?.trim();

  if (remaining && open) {
    return `Talepler ${open} gün açık kalır; bu talebin süresinin dolmasına ${remaining} gün kaldı.`;
  }

  return remaining ? `Talebin süresinin dolmasına ${remaining} gün kaldı.` : null;
}

function expiryLine(value: string | null | undefined, subject: string): string | null {
  const formatted = formatMoment(value);
  return formatted ? `${subject} geçerlilik süresi: ${formatted}.` : null;
}

function formatMoment(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) {
    return null;
  }

  const moment = new Date(raw);
  if (Number.isNaN(moment.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Europe/Istanbul',
  }).format(moment);
}

function renderText(paragraphs: string[], action: EmailAction): string {
  const lines = [...paragraphs];

  if (action) {
    lines.push(`${action.label}: ${action.url}`);
  }

  lines.push('— TakTic');

  return `${lines.join('\n\n')}\n`;
}

function renderHtml(subject: string, paragraphs: string[], action: EmailAction): string {
  const body = paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`);

  if (action) {
    // A plain anchor with the real href. Nothing rewrites or wraps it: click
    // tracking is off for this domain, and a redirect host in a security link
    // is exactly what a recipient is told to be suspicious of.
    body.push(
      `<p><a href="${escapeHtml(action.url)}">${escapeHtml(action.label)}</a></p>`,
      `<p>${escapeHtml('Bağlantı çalışmazsa adresi tarayıcınıza yapıştırın:')}<br />` +
        `<span>${escapeHtml(action.url)}</span></p>`,
    );
  }

  body.push('<p>— TakTic</p>');

  return [
    '<!doctype html>',
    '<html lang="tr">',
    '<head><meta charset="utf-8" />',
    `<title>${escapeHtml(subject)}</title>`,
    '</head>',
    '<body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111">',
    ...body,
    '</body>',
    '</html>',
  ].join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isPresent(value: string | null): value is string {
  return value !== null;
}
