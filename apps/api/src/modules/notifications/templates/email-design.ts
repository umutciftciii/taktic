import { EmailBranding, EMAIL_LOGO_WIDTH } from '../email-branding.config';
import { escapeHtml } from './format';

/**
 * The TakTick e-mail shell, transcribed from the design handoff.
 *
 * The markup below is not "inspired by" the handoff files — it is the same
 * markup, block for block, because the handoff's own constraint is that the
 * *output* keeps the structural rules e-mail clients need: nested
 * `role="presentation"` tables, every style inline, a 600px card, the MSO font
 * fallback, `mso-line-height-rule:exactly` on every line height, and a single
 * `<style>` block. Rebuilding it as blocks is what lets every template share
 * one shell without a copy per message drifting apart.
 *
 * The one thing the shell carries that the handoff did not is dark mode — see
 * {@link darkModeCss}. The handoff opted into it with the `color-scheme` meta
 * and stopped there, which is worse than not opting in: a client that honours
 * the opt-in paints its own dark canvas under text that is inline `#201e1d`.
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

/**
 * The context label in the header's right-hand corner.
 *
 * `DESTEK` is the one label that names an internal mailbox rather than a side
 * of the marketplace. It exists because the two support-ticket messages that go
 * to the operator inbox are read next to the three that go to the customer, and
 * an operator glancing at a card has to be able to tell at once which of the
 * two they are looking at.
 */
export type EmailAudience = 'HESAP' | 'HİZMET ALAN' | 'HİZMET VEREN' | 'DESTEK';

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
   * This product has no preference centre and no unsubscribe list, and every
   * message here is a mandatory transactional notice that would not be subject
   * to one anyway — so rather than ship two dead links, the footer
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

/**
 * The colours, as one table per scheme.
 *
 * `light` is the design handoff, unchanged. `dark` is what the same surfaces
 * become when a client tells us it prefers a dark scheme: the page and the
 * card go dark, the ink goes light, the 2px structure keeps its contrast by
 * flipping with the ink, the accent is lifted because `#ec3013` on a dark card
 * falls under 4.5:1 for the 11px kicker, and the logo band stays white so the
 * one logo asset — black ink on an opaque white plate — keeps sitting on its
 * own plate instead of floating as a white rectangle over a dark card.
 *
 * Exported so the tests can check the contrast of the pairs the shell uses
 * rather than only that the strings are present.
 */
export type EmailTheme = {
  page: string;
  card: string;
  head: string;
  ink: string;
  muted: string;
  rule: string;
  hairline: string;
  accent: string;
  cta: string;
  ctaText: string;
  ghost: string;
};

export const EMAIL_THEME: { light: EmailTheme; dark: EmailTheme } = {
  light: {
    page: '#e7e5e3',
    card: '#ffffff',
    head: '#ffffff',
    ink: '#201e1d',
    muted: '#6b6663',
    rule: '#201e1d',
    hairline: '#d5d1ce',
    accent: '#ec3013',
    cta: '#ec3013',
    ctaText: '#ffffff',
    ghost: '#fbfafa',
  },
  dark: {
    page: '#121110',
    card: '#242120',
    head: '#ffffff',
    ink: '#f3f1ef',
    muted: '#b3aca8',
    rule: '#f3f1ef',
    hairline: '#3f3b38',
    accent: '#ff5a3c',
    cta: '#ec3013',
    ctaText: '#ffffff',
    ghost: '#242120',
  },
};

const INK = EMAIL_THEME.light.ink;
const ACCENT = EMAIL_THEME.light.accent;
const MUTED = EMAIL_THEME.light.muted;
const HAIRLINE = EMAIL_THEME.light.hairline;
const PAGE = EMAIL_THEME.light.page;
const CARD = EMAIL_THEME.light.card;
const GHOST_FILL = EMAIL_THEME.light.ghost;
const HEAD = EMAIL_THEME.light.head;

const FONT = 'Arial, Helvetica, sans-serif';

/**
 * `branding` is passed in rather than read here.
 *
 * It used to be an ambient environment read, which is how a footer naming a
 * placeholder support address reached a real customer: nothing in the call
 * chain had to acknowledge that the values might not be publishable. Now the
 * caller resolves them — from the admin-managed settings — and a caller that
 * cannot is expected to refuse the send instead of rendering.
 */
export function renderDocument(document: EmailDocument, branding: EmailBranding): RenderedDocument {
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

function renderHtml(document: EmailDocument, branding: EmailBranding): string {
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
  :root{color-scheme:light dark;supported-color-schemes:light dark;}
  @media only screen and (max-width:620px){
    .wrap{width:100% !important;}
    .pad{padding-left:24px !important;padding-right:24px !important;}
    .h1{font-size:26px !important;line-height:32px !important;}
  }
${darkModeCss()}
</style>
</head>
<body bgcolor="${PAGE}" style="margin:0;padding:0;background-color:${PAGE};">
<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;">${escapeHtml(document.preheader)}</span>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${PAGE}" style="width:100%;background-color:${PAGE};">
<tr><td align="center" class="dm-page" bgcolor="${PAGE}" style="padding:32px 12px;background-color:${PAGE};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="wrap dm-card" bgcolor="${CARD}" style="width:600px;max-width:600px;background-color:${CARD};border:2px solid ${INK};">
    <tr><td class="pad dm-head" bgcolor="${HEAD}" style="padding:22px 40px;background-color:${HEAD};">
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
 * Dark mode, in three layers that each cover a different kind of client.
 *
 * 1. **Attributes and inline colours** (written by the shell, not here): every
 *    surface carries `bgcolor` next to its `background-color`, and every
 *    text-bearing element carries its own `color`. A client that strips
 *    `<style>` — or that inverts colours on its own, as the Gmail apps and
 *    Windows Outlook do — sees a light canvas with dark ink on it and inverts
 *    the two together. Text never inherits its colour from a container whose
 *    background the client may have replaced.
 *
 * 2. **`prefers-color-scheme: dark`** for the clients that honour it (Apple
 *    Mail on macOS and iOS, Outlook for Mac and iOS, Samsung Mail, Thunderbird):
 *    class-based overrides with `!important`, since they compete with the inline
 *    styles the first layer needs. The header band is pinned white on purpose —
 *    see {@link EMAIL_THEME}.
 *
 * 3. **Outlook's rewrite** (outlook.com, Outlook for Windows/Android with the
 *    new rendering): it recolours elements itself, ignores the media query, and
 *    marks what it changed with `data-ogsc` (colour) and `data-ogsb`
 *    (background). The same rules, re-bound under those attributes, put ours
 *    back. This is the whole of the client-specific CSS; nothing else in the
 *    shell is conditional on a client.
 *
 * Gmail's web client leaves message colours alone in its dark theme and does
 * not support the media query, so for it the first layer is the whole story.
 */
function darkModeCss(): string {
  const dark = EMAIL_THEME.dark;

  return `  @media (prefers-color-scheme: dark){
    body,.dm-page{background-color:${dark.page} !important;}
    .dm-card{background-color:${dark.card} !important;border-color:${dark.rule} !important;}
    .dm-head{background-color:${HEAD} !important;}
    .dm-rule{background-color:${dark.rule} !important;}
    .dm-hair{border-color:${dark.hairline} !important;}
    .dm-ink{color:${dark.ink} !important;}
    .dm-muted{color:${dark.muted} !important;}
    .dm-accent{color:${dark.accent} !important;}
    .dm-link{color:${dark.ink} !important;}
    .dm-link-muted{color:${dark.muted} !important;}
    .dm-cta{background-color:${dark.cta} !important;}
    .dm-cta-link{color:${dark.ctaText} !important;}
    .dm-ghost{background-color:${dark.card} !important;border-color:${dark.ink} !important;}
    .dm-ghost-link{color:${dark.ink} !important;}
  }
  [data-ogsb] .dm-page{background-color:${dark.page} !important;}
  [data-ogsb] .dm-card{background-color:${dark.card} !important;}
  [data-ogsb] .dm-head{background-color:${HEAD} !important;}
  [data-ogsb] .dm-rule{background-color:${dark.rule} !important;}
  [data-ogsb] .dm-cta{background-color:${dark.cta} !important;}
  [data-ogsb] .dm-ghost{background-color:${dark.card} !important;}
  [data-ogsc] .dm-card{border-color:${dark.rule} !important;}
  [data-ogsc] .dm-ghost{border-color:${dark.ink} !important;}
  [data-ogsc] .dm-hair{border-color:${dark.hairline} !important;}
  [data-ogsc] .dm-ink{color:${dark.ink} !important;}
  [data-ogsc] .dm-muted{color:${dark.muted} !important;}
  [data-ogsc] .dm-accent{color:${dark.accent} !important;}
  [data-ogsc] .dm-link{color:${dark.ink} !important;}
  [data-ogsc] .dm-link-muted{color:${dark.muted} !important;}
  [data-ogsc] .dm-cta-link{color:${dark.ctaText} !important;}
  [data-ogsc] .dm-ghost-link{color:${dark.ink} !important;}`;
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
  branding: EmailBranding,
): string {
  const support = escapeHtml(branding.supportEmail);
  const company = [branding.companyName, branding.companyAddress]
    .filter((part): part is string => Boolean(part))
    .map(escapeHtml)
    .join(' · ');

  const accountLine = document.accountUrl
    ? `<br><a href="${escapeHtml(document.accountUrl)}" class="dm-link-muted" style="color:${MUTED};text-decoration:underline;">Hesap ayarları</a>`
    : '';

  return `<p class="dm-muted" style="margin:0 0 10px 0;font-family:${FONT};font-size:12px;line-height:19px;mso-line-height-rule:exactly;color:${MUTED};">Bu e-posta TakTick hesabınızla ilgili bir işlem sonucu gönderildi.<br>Sorularınız için <a href="mailto:${support}" class="dm-link" style="color:${INK};text-decoration:underline;">${support}</a> adresine yazabilirsiniz.</p>
      <p class="dm-muted" style="margin:0;font-family:${FONT};font-size:11px;line-height:18px;mso-line-height-rule:exactly;color:${MUTED};">${company}<br>Bu ileti, hesabınızla ilgili zorunlu bir işlem bildirimidir; pazarlama içermez.${accountLine}</p>`;
}

function ruleHtml(): string {
  return `<tr><td><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;"><tr><td height="2" class="dm-rule" bgcolor="${INK}" style="height:2px;line-height:2px;font-size:0;background-color:${INK};">&nbsp;</td></tr></table></td></tr>`;
}

function kickerHtml(text: string): string {
  return `<p class="dm-accent" style="margin:0 0 14px 0;font-family:${FONT};font-size:11px;line-height:16px;mso-line-height-rule:exactly;letter-spacing:0.14em;text-transform:uppercase;color:${ACCENT};font-weight:bold;">${escapeHtml(text)}</p>`;
}

function headingHtml(text: string): string {
  return `<h1 class="h1 dm-ink" style="margin:0 0 22px 0;font-family:${FONT};font-size:30px;line-height:36px;mso-line-height-rule:exactly;font-weight:bold;letter-spacing:-0.02em;color:${INK};">${escapeHtml(text)}</h1>`;
}

function paragraphHtml(text: string): string {
  return `<p class="dm-ink" style="margin:0 0 16px 0;font-family:${FONT};font-size:15px;line-height:24px;mso-line-height-rule:exactly;color:${INK};">${escapeHtml(text)}</p>`;
}

function signatureHtml(): string {
  return `<p class="dm-ink" style="margin:26px 0 0 0;font-family:${FONT};font-size:15px;line-height:24px;mso-line-height-rule:exactly;color:${INK};">Saygılarımızla,<br><strong>TakTick Ekibi</strong></p>`;
}

function blockHtml(block: EmailBlock): string {
  switch (block.kind) {
    case 'paragraph':
      return paragraphHtml(block.text);

    case 'spacer':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td height="${block.height}" style="height:${block.height}px;line-height:${block.height}px;font-size:0;">&nbsp;</td></tr></table>`;

    case 'sectionLabel':
      return `<p class="dm-muted" style="margin:0 0 14px 0;font-family:${FONT};font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${MUTED};font-weight:bold;">${escapeHtml(block.text)}</p>`;

    case 'note':
      return `<p class="dm-muted" style="margin:0;font-family:${FONT};font-size:13px;line-height:20px;mso-line-height-rule:exactly;color:${MUTED};">${escapeHtml(block.text)}</p>`;

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
      ? `<td class="dm-cta" bgcolor="${ACCENT}" style="background-color:${ACCENT};mso-line-height-rule:exactly;line-height:20px;">`
      : `<td class="dm-ghost" bgcolor="${GHOST_FILL}" style="background-color:${GHOST_FILL};border:2px solid ${INK};mso-line-height-rule:exactly;line-height:20px;">`;
  const color = block.variant === 'primary' ? EMAIL_THEME.light.ctaText : INK;
  const linkClass = block.variant === 'primary' ? 'dm-cta-link' : 'dm-ghost-link';

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        ${cell}
          <a href="${escapeHtml(url)}" class="${linkClass}" style="display:block;padding:15px 26px;font-family:${FONT};font-size:14px;font-weight:bold;letter-spacing:0.06em;text-transform:uppercase;color:${color};text-decoration:none;">${escapeHtml(block.label)}</a>
        </td></tr></table>`;
}

function dataTableHtml(rows: EmailDataRow[]): string {
  const cells = rows
    .map(
      (row) => `
    <tr>
      <td width="150" class="dm-hair dm-muted" style="width:150px;padding:12px 12px 12px 0;border-bottom:1px solid ${HAIRLINE};font-family:${FONT};font-size:11px;line-height:16px;mso-line-height-rule:exactly;letter-spacing:0.09em;text-transform:uppercase;color:${MUTED};vertical-align:top;">${escapeHtml(row.label)}</td>
      <td class="dm-hair dm-ink" style="padding:12px 0;border-bottom:1px solid ${HAIRLINE};font-family:${FONT};font-size:15px;line-height:22px;mso-line-height-rule:exactly;color:${INK};font-weight:bold;vertical-align:top;">${escapeHtml(row.value)}</td>
    </tr>`,
    )
    .join('');

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="dm-hair" style="width:100%;border-top:1px solid ${HAIRLINE};">${cells}
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
function renderText(document: EmailDocument, branding: EmailBranding): string {
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
