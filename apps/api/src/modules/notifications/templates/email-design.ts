import { readEmailBranding, EMAIL_LOGO_WIDTH } from '../email-branding.config';
import { escapeHtml } from './format';

/**
 * The TakTick e-mail shell, transcribed from the design handoff.
 *
 * The markup below is not "inspired by" the handoff files — it is the same
 * markup, block for block, because the handoff's own constraint is that the
 * *output* keeps the structural rules e-mail clients need: nested
 * `role="presentation"` tables, every style inline, a 600px card, the MSO font
 * fallback, `mso-line-height-rule:exactly` on every line height, and a single
 * `<style>` block carrying nothing but the ≤620px media query. Rebuilding it as
 * blocks is what lets twelve templates share one shell without twelve copies
 * drifting apart.
 *
 * Three things the design preview had that production must not:
 *
 * - the subject-line caption under the card, which existed only so a reviewer
 *   could see the subject next to the design;
 * - the relative `../assets/logo-email.png` source, replaced by an absolute URL
 *   built from the deployment's own asset base;
 * - the placeholder `taktick.com` links, replaced by real routes and, where the
 *   product genuinely has no destination, removed rather than left dangling.
 *
 * Every interpolated value is escaped. The values include an offer note and a
 * business name — text a provider typed — so an unescaped body would let a
 * provider put their own markup, and their own links, inside a message the
 * customer trusts because the platform sent it.
 */

/** The context label in the header's right-hand corner. */
export type EmailAudience = 'HESAP' | 'HİZMET ALAN' | 'HİZMET VEREN';

export type EmailDataRow = {
  label: string;
  value: string;
};

export type EmailBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'spacer'; height: number }
  | { kind: 'cta'; label: string; url: string; variant: 'primary' | 'ghost' }
  | { kind: 'sectionLabel'; text: string }
  | { kind: 'dataTable'; rows: EmailDataRow[] }
  | { kind: 'note'; text: string };

export type EmailDocument = {
  subject: string;
  /** ~85 characters, shown beside the subject in the inbox list. */
  preheader: string;
  audience: EmailAudience;
  /** One or two words: "Yeni teklif", "Kabul edildi". */
  kicker: string;
  heading: string;
  /**
   * The recipient's full name. Rendered as `Sayın {fullName},` and required by
   * construction — the editorial rule is that every message opens with exactly
   * one salutation in exactly that form, so it is a field of the document
   * rather than something a template can forget to add.
   */
  fullName: string;
  blocks: EmailBlock[];
  /**
   * A real settings page for this recipient, or null.
   *
   * The design's footer carried "Bildirim tercihleri" and "Bildirimlerden çık".
   * This product has no preference centre and no unsubscribe list, and these
   * twelve messages are mandatory transactional notices that would not be
   * subject to one anyway — so rather than ship two dead links, the footer
   * carries one link to a page that exists and says plainly what kind of
   * message this is. See {@link renderFooter}.
   */
  accountUrl: string | null;
};

export type RenderedDocument = {
  subject: string;
  html: string;
  text: string;
};

const INK = '#201e1d';
const ACCENT = '#ec3013';
const MUTED = '#6b6663';
const HAIRLINE = '#d5d1ce';
const PAGE = '#e7e5e3';
const CARD = '#ffffff';
const GHOST_FILL = '#fbfafa';

const FONT = 'Arial, Helvetica, sans-serif';

export function renderDocument(document: EmailDocument): RenderedDocument {
  const branding = readEmailBranding();

  return {
    subject: document.subject,
    html: renderHtml(document, branding),
    text: renderText(document, branding),
  };
}

/** `Sayın {fullName},` — the one salutation form the editorial rules allow. */
export function salutation(fullName: string): string {
  return `Sayın ${fullName.trim()},`;
}

function renderHtml(document: EmailDocument, branding: ReturnType<typeof readEmailBranding>): string {
  const body = [
    kickerHtml(document.kicker),
    headingHtml(document.heading),
    paragraphHtml(salutation(document.fullName)),
    ...document.blocks.map(blockHtml),
    signatureHtml(),
  ].join('');

  return `<!DOCTYPE html>
<html lang="tr"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(document.subject)}</title>
<!--[if mso]><style>body,table,td,a{font-family:Arial,Helvetica,sans-serif !important;}</style><![endif]-->
<style>
  @media only screen and (max-width:620px){
    .wrap{width:100% !important;}
    .pad{padding-left:24px !important;padding-right:24px !important;}
    .h1{font-size:26px !important;line-height:32px !important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${PAGE};">
<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;">${escapeHtml(document.preheader)}</span>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;background-color:${PAGE};">
<tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="wrap" style="width:600px;max-width:600px;background-color:${CARD};border:2px solid ${INK};">
    <tr><td class="pad" style="padding:22px 40px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;"><tr>
        <td align="left" style="line-height:0;font-size:0;"><img src="${escapeHtml(branding.logoUrl)}" width="${EMAIL_LOGO_WIDTH}" alt="TakTick" style="display:block;width:${EMAIL_LOGO_WIDTH}px;max-width:${EMAIL_LOGO_WIDTH}px;height:auto;border:0;"></td>
        <td align="right" style="font-family:${FONT};font-size:10px;line-height:24px;mso-line-height-rule:exactly;letter-spacing:0.14em;text-transform:uppercase;color:${MUTED};">${escapeHtml(document.audience)}</td>
      </tr></table>
    </td></tr>
    ${ruleHtml()}
    <tr><td class="pad" style="padding:40px 40px 44px 40px;">
      ${body}
    </td></tr>
    ${ruleHtml()}
    <tr><td class="pad" style="padding:24px 40px 30px 40px;">
      ${renderFooter(document, branding)}
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

/**
 * The honest footer.
 *
 * The support line is unchanged from the design. The second paragraph is where
 * this differs: the design's "Bildirim tercihleri · Bildirimlerden çık" pair
 * described a preference centre this product does not have, and applying an
 * unsubscribe to a password-reset mail would be wrong even if it did. So the
 * line states what the message is — a mandatory account notice, not marketing —
 * and links to the recipient's real settings page when there is one.
 */
function renderFooter(
  document: EmailDocument,
  branding: ReturnType<typeof readEmailBranding>,
): string {
  const support = escapeHtml(branding.supportEmail);
  const company = [branding.companyName, branding.companyAddress]
    .filter((part): part is string => Boolean(part))
    .map(escapeHtml)
    .join(' · ');

  const accountLine = document.accountUrl
    ? `<br><a href="${escapeHtml(document.accountUrl)}" style="color:${MUTED};text-decoration:underline;">Hesap ayarları</a>`
    : '';

  return `<p style="margin:0 0 10px 0;font-family:${FONT};font-size:12px;line-height:19px;mso-line-height-rule:exactly;color:${MUTED};">Bu e-posta TakTick hesabınızla ilgili bir işlem sonucu gönderildi.<br>Sorularınız için <a href="mailto:${support}" style="color:${INK};text-decoration:underline;">${support}</a> adresine yazabilirsiniz.</p>
      <p style="margin:0;font-family:${FONT};font-size:11px;line-height:18px;mso-line-height-rule:exactly;color:${MUTED};">${company}<br>Bu ileti, hesabınızla ilgili zorunlu bir işlem bildirimidir; pazarlama içermez.${accountLine}</p>`;
}

function ruleHtml(): string {
  return `<tr><td><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;"><tr><td height="2" style="height:2px;line-height:2px;font-size:0;background-color:${INK};">&nbsp;</td></tr></table></td></tr>`;
}

function kickerHtml(text: string): string {
  return `<p style="margin:0 0 14px 0;font-family:${FONT};font-size:11px;line-height:16px;mso-line-height-rule:exactly;letter-spacing:0.14em;text-transform:uppercase;color:${ACCENT};font-weight:bold;">${escapeHtml(text)}</p>`;
}

function headingHtml(text: string): string {
  return `<h1 class="h1" style="margin:0 0 22px 0;font-family:${FONT};font-size:30px;line-height:36px;mso-line-height-rule:exactly;font-weight:bold;letter-spacing:-0.02em;color:${INK};">${escapeHtml(text)}</h1>`;
}

function paragraphHtml(text: string): string {
  return `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:15px;line-height:24px;mso-line-height-rule:exactly;color:${INK};">${escapeHtml(text)}</p>`;
}

function signatureHtml(): string {
  return `<p style="margin:26px 0 0 0;font-family:${FONT};font-size:15px;line-height:24px;mso-line-height-rule:exactly;color:${INK};">Saygılarımızla,<br><strong>TakTick Ekibi</strong></p>`;
}

function blockHtml(block: EmailBlock): string {
  switch (block.kind) {
    case 'paragraph':
      return paragraphHtml(block.text);

    case 'spacer':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td height="${block.height}" style="height:${block.height}px;line-height:${block.height}px;font-size:0;">&nbsp;</td></tr></table>`;

    case 'sectionLabel':
      return `<p style="margin:0 0 14px 0;font-family:${FONT};font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${MUTED};font-weight:bold;">${escapeHtml(block.text)}</p>`;

    case 'note':
      return `<p style="margin:0;font-family:${FONT};font-size:13px;line-height:20px;mso-line-height-rule:exactly;color:${MUTED};">${escapeHtml(block.text)}</p>`;

    case 'cta':
      return ctaHtml(block);

    case 'dataTable':
      return dataTableHtml(block.rows);
  }
}

function ctaHtml(block: Extract<EmailBlock, { kind: 'cta' }>): string {
  const url = assertSafeUrl(block.url);
  const cell =
    block.variant === 'primary'
      ? `<td bgcolor="${ACCENT}" style="mso-line-height-rule:exactly;line-height:20px;">`
      : `<td bgcolor="${GHOST_FILL}" style="border:2px solid ${INK};mso-line-height-rule:exactly;line-height:20px;">`;
  const color = block.variant === 'primary' ? '#ffffff' : INK;

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        ${cell}
          <a href="${escapeHtml(url)}" style="display:block;padding:15px 26px;font-family:${FONT};font-size:14px;font-weight:bold;letter-spacing:0.06em;text-transform:uppercase;color:${color};text-decoration:none;">${escapeHtml(block.label)}</a>
        </td></tr></table>`;
}

function dataTableHtml(rows: EmailDataRow[]): string {
  const cells = rows
    .map(
      (row) => `
    <tr>
      <td width="150" style="width:150px;padding:12px 12px 12px 0;border-bottom:1px solid ${HAIRLINE};font-family:${FONT};font-size:11px;line-height:16px;mso-line-height-rule:exactly;letter-spacing:0.09em;text-transform:uppercase;color:${MUTED};vertical-align:top;">${escapeHtml(row.label)}</td>
      <td style="padding:12px 0;border-bottom:1px solid ${HAIRLINE};font-family:${FONT};font-size:15px;line-height:22px;mso-line-height-rule:exactly;color:${INK};font-weight:bold;vertical-align:top;">${escapeHtml(row.value)}</td>
    </tr>`,
    )
    .join('');

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-top:1px solid ${HAIRLINE};">${cells}
  </table>`;
}

/**
 * The last line of defence on a link.
 *
 * Every URL in these messages is built by this application from configuration
 * and a route constant, so this should never fire. It exists because the cost
 * of being wrong once — a `javascript:` or `data:` href inside a message a
 * recipient trusts — is high enough that "it cannot happen" is not a good enough
 * reason to skip the check.
 */
function assertSafeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('An e-mail call to action must carry an absolute URL.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('An e-mail call to action must use http or https.');
  }

  return parsed.toString();
}

/**
 * The plain-text body.
 *
 * It says the same thing the HTML does rather than a reduced version: a client
 * that shows text-only must not present a worse message, and a security link
 * that only exists in the HTML half is a link half the recipients cannot use.
 */
function renderText(document: EmailDocument, branding: ReturnType<typeof readEmailBranding>): string {
  const lines: string[] = [document.heading, '', salutation(document.fullName)];

  for (const block of document.blocks) {
    switch (block.kind) {
      case 'paragraph':
      case 'note':
        lines.push('', block.text);
        break;

      case 'sectionLabel':
        lines.push('', block.text.toLocaleUpperCase('tr-TR'));
        break;

      case 'dataTable':
        lines.push('');
        for (const row of block.rows) {
          lines.push(`${row.label}: ${row.value}`);
        }
        break;

      case 'cta':
        lines.push('', `${block.label}: ${assertSafeUrl(block.url)}`);
        break;

      case 'spacer':
        break;
    }
  }

  lines.push('', 'Saygılarımızla,', 'TakTick Ekibi', '', '—');
  lines.push(`Sorularınız için ${branding.supportEmail} adresine yazabilirsiniz.`);
  lines.push(
    [branding.companyName, branding.companyAddress].filter(Boolean).join(' · '),
  );
  lines.push('Bu ileti, hesabınızla ilgili zorunlu bir işlem bildirimidir; pazarlama içermez.');

  if (document.accountUrl) {
    lines.push(`Hesap ayarları: ${document.accountUrl}`);
  }

  return `${lines.join('\n')}\n`;
}
