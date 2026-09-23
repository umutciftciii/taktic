import { describe, expect, it } from 'vitest';
import { renderEmail } from '../src/modules/notifications/email-template';
import { EmailBranding } from '../src/modules/notifications/email-branding.config';
import { NotificationMessage } from '../src/modules/notifications/notification.port';
import { EMAIL_THEME } from '../src/modules/notifications/templates/email-design';
import {
  TRANSACTIONAL_EMAIL_TEMPLATES,
  TransactionalEmailTemplate,
  transactionalSubject,
} from '../src/modules/notifications/templates/transactional-templates';

/**
 * REQ-UX-007 — what the shell has to do so a message stays readable when the
 * client, not the template, decides the colours.
 *
 * The defect these cases pin down: the shell opted into dark mode with the
 * `color-scheme` meta and shipped no dark rules, no `bgcolor` fallbacks and no
 * class hooks. A client honouring the opt-in painted its own dark canvas under
 * text that was inline `#201e1d`, and the body vanished.
 *
 * Three layers, each asserted on every template rather than on the shell in
 * isolation, because "the shell is right" proves nothing if a family had
 * quietly grown a renderer of its own:
 *
 * 1. light-mode fallbacks a client that strips `<style>` still honours;
 * 2. `prefers-color-scheme: dark` overrides for clients that support them;
 * 3. the same overrides re-bound for Outlook's `data-ogsc`/`data-ogsb`
 *    rewrite, and inline colours on every text-bearing element so a client
 *    that inverts colours inverts the text with its background.
 */

const WEB = 'https://app.example.test';

const BRANDING: EmailBranding = {
  supportEmail: 'destek@example.test',
  companyName: 'TakTick Teknoloji A.Ş.',
  companyAddress: 'Kızılırmak Mah. No:12, Çankaya/Ankara',
  logoUrl: 'https://cdn.example.test/brand/logo-email.png',
};

/**
 * One payload for every template: enough to render, never a real value. The
 * per-field behaviour of each template is the other spec's business — here
 * only the shell around the blocks is under test.
 */
function messageFor(template: TransactionalEmailTemplate): NotificationMessage {
  const data = {
    fullName: 'Deniz Yılmaz',
    name: 'Deniz Yılmaz',
    businessName: 'Örnek İşletme',
    providerName: 'Örnek İşletme',
    customerName: 'Deniz Yılmaz',
    requestNumber: '#T-1',
    categoryName: 'Kombi Servisi',
    city: 'Ankara',
    district: 'Çankaya',
    accountUrl: `${WEB}/hesap`,
    requestUrl: `${WEB}/requests/r1`,
  };

  return {
    template,
    to: 'alici@example.test',
    subject: transactionalSubject(template, data),
    actionUrl: `${WEB}/etkinlestir`,
    data,
  };
}

function html(template: TransactionalEmailTemplate): string {
  return renderEmail(messageFor(template), BRANDING).html;
}

/** The single `<style>` block the shell writes — not the one inside the MSO conditional. */
function styleBlock(markup: string): string {
  const withoutMso = markup.replace(/<!--\[if mso\]>[\s\S]*?<!\[endif\]-->/g, '');
  const blocks = [...withoutMso.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? '');
  expect(blocks).toHaveLength(1);
  return blocks[0] ?? '';
}

/** The body of the `@media (prefers-color-scheme: dark)` rule, braces balanced. */
function darkBlock(css: string): string {
  const start = css.indexOf('@media (prefers-color-scheme: dark)');
  expect(start).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced dark-mode block');
}

/** The opening tags of every element that carries visible text. */
function textTags(markup: string): string[] {
  return [...markup.matchAll(/<(p|h1|a|strong)\b[^>]*>/g)].map((m) => m[0]);
}

/** One representative per family the brief names, so a regression is named by family. */
const FAMILIES: Record<string, TransactionalEmailTemplate[]> = {
  aktivasyon: ['customer-activation', 'email-verification', 'password-reset', 'provider-claim'],
  'telefon doğrulama': ['request-received'],
  'talep/teklif yaşam döngüsü': [
    'request-published',
    'offer-received',
    'match-customer',
    'offer-accepted',
    'offer-not-selected',
    'request-expiring',
    'request-expired-customer',
  ],
  'review/moderasyon': [
    'review-invitation',
    'review-received',
    'review-removed',
    'review-report-new-for-support',
    'request-removed',
  ],
  'ödeme/vitrin': [
    'package-purchase-confirmation',
    'showcase-package-payment-succeeded',
    'showcase-package-payment-failed',
    'showcase-placement-activated',
    'showcase-lead-received',
    'package-refund-status',
  ],
  destek: ['support-ticket-created', 'support-ticket-provider-admin-reply'],
};

const { light, dark } = EMAIL_THEME;

describe('transactional e-mail dark mode (REQ-UX-007)', () => {
  it('names one representative per family, and every representative is a real template', () => {
    for (const templates of Object.values(FAMILIES)) {
      for (const template of templates) {
        expect(TRANSACTIONAL_EMAIL_TEMPLATES).toContain(template);
      }
    }
  });

  describe.each(TRANSACTIONAL_EMAIL_TEMPLATES)('%s', (template) => {
    it('declares both colour schemes in the head and on the root', () => {
      const markup = html(template);

      expect(markup).toContain('<meta name="color-scheme" content="light dark">');
      expect(markup).toContain('<meta name="supported-color-schemes" content="light dark">');
      expect(styleBlock(markup)).toContain(
        ':root{color-scheme:light dark;supported-color-schemes:light dark;}',
      );
    });

    it('paints the light canvas with attributes, not only with style', () => {
      const markup = html(template);

      // The page, the card, the header band and the structural rules — the
      // surfaces a client that drops `style` would otherwise leave transparent.
      expect(markup).toMatch(new RegExp(`<body[^>]*bgcolor="${light.page}"`));
      expect(markup).toMatch(new RegExp(`<td[^>]*class="dm-page"[^>]*bgcolor="${light.page}"`));
      expect(markup).toMatch(
        new RegExp(`<table[^>]*class="wrap dm-card"[^>]*bgcolor="${light.card}"`),
      );
      expect(markup).toMatch(new RegExp(`<td[^>]*class="pad dm-head"[^>]*bgcolor="${light.card}"`));
      expect(markup).toMatch(new RegExp(`<td[^>]*class="dm-rule"[^>]*bgcolor="${light.rule}"`));
      // The light surface colours are still the design's.
      expect(markup).toContain(`background-color:${light.page};`);
      expect(markup).toContain(`background-color:${light.card};border:2px solid ${light.rule};`);
    });

    it('sets an inline colour on every element that carries text', () => {
      const tags = textTags(html(template)).filter((tag) => !tag.startsWith('<strong'));

      expect(tags.length).toBeGreaterThan(5);
      for (const tag of tags) {
        expect(tag, tag).toMatch(/style="(?:[^"]*;)?color:#[0-9a-f]{6}/);
      }
    });

    it('hooks every text element to a dark-mode class', () => {
      const tags = textTags(html(template)).filter((tag) => !tag.startsWith('<strong'));

      for (const tag of tags) {
        // The preheader is the one text element that must stay invisible.
        if (tag.includes('mso-hide:all')) continue;
        expect(tag, tag).toMatch(/class="[^"]*\bdm-(ink|muted|accent|link|cta|ghost)\b/);
      }
    });

    it('overrides the surfaces and the text under prefers-color-scheme: dark', () => {
      const rules = darkBlock(styleBlock(html(template)));

      expect(rules).toContain(`.dm-page{background-color:${dark.page} !important;}`);
      expect(rules).toContain(
        `.dm-card{background-color:${dark.card} !important;border-color:${dark.rule} !important;}`,
      );
      expect(rules).toContain(`.dm-rule{background-color:${dark.rule} !important;}`);
      expect(rules).toContain(`.dm-hair{border-color:${dark.hairline} !important;}`);
      expect(rules).toContain(`.dm-ink{color:${dark.ink} !important;}`);
      expect(rules).toContain(`.dm-muted{color:${dark.muted} !important;}`);
      expect(rules).toContain(`.dm-accent{color:${dark.accent} !important;}`);
      expect(rules).toContain(`.dm-link{color:${dark.ink} !important;}`);
      expect(rules).toContain(`.dm-cta{background-color:${dark.cta} !important;}`);
      expect(rules).toContain(`.dm-cta-link{color:${dark.ctaText} !important;}`);
      expect(rules).toContain(
        `.dm-ghost{background-color:${dark.card} !important;border-color:${dark.ink} !important;}`,
      );
      expect(rules).toContain(`.dm-ghost-link{color:${dark.ink} !important;}`);
    });

    it('keeps the logo band light in both schemes rather than shipping a second logo', () => {
      const markup = html(template);
      const images = [...markup.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);

      expect(images).toHaveLength(1);
      expect(images[0]).toContain('/brand/logo-email.png');
      expect(markup).not.toMatch(/logo-[a-z-]*dark/i);
      expect(darkBlock(styleBlock(markup))).toContain(
        `.dm-head{background-color:${light.card} !important;}`,
      );
    });

    it('re-binds the dark rules for Outlook’s data-ogsc / data-ogsb rewrite', () => {
      const css = styleBlock(html(template));

      expect(css).toContain(`[data-ogsc] .dm-ink{color:${dark.ink} !important;}`);
      expect(css).toContain(`[data-ogsc] .dm-muted{color:${dark.muted} !important;}`);
      expect(css).toContain(`[data-ogsb] .dm-card{background-color:${dark.card} !important;}`);
      expect(css).toContain(`[data-ogsb] .dm-page{background-color:${dark.page} !important;}`);
      expect(css).toContain(`[data-ogsb] .dm-head{background-color:${light.card} !important;}`);
      expect(css).toContain(`[data-ogsc] .dm-card{border-color:${dark.rule} !important;}`);
      expect(css).toContain(`[data-ogsc] .dm-hair{border-color:${dark.hairline} !important;}`);
    });

    it('leaks no dark rule into the light rendering', () => {
      const css = styleBlock(html(template));
      const outsideDark = css.replace(darkBlock(css), '');
      const selectors = [...outsideDark.matchAll(/([^{}]+)\{/g)]
        .map((m) => (m[1] ?? '').trim())
        .filter((selector) => selector.includes('.dm-'));

      expect(selectors.length).toBeGreaterThan(0);
      for (const selector of selectors) {
        expect(selector, selector).toMatch(/^\[data-ogs[cb]\] /);
      }
      // The mobile query is untouched.
      expect(css).toContain('@media only screen and (max-width:620px)');
    });
  });

  describe('every family renders through the one shell', () => {
    const [reference, ...rest] = TRANSACTIONAL_EMAIL_TEMPLATES;
    const headOf = (markup: string) =>
      (markup.match(/<head>[\s\S]*<\/head>/) ?? [''])[0].replace(/<title>[\s\S]*?<\/title>/, '');

    it.each(Object.entries(FAMILIES))('%s', (_family, templates) => {
      const referenceHead = headOf(html(reference));
      for (const template of templates) {
        expect(headOf(html(template)), template).toBe(referenceHead);
      }
    });

    it('holds for the remaining templates as well', () => {
      const referenceHead = headOf(html(reference));
      for (const template of rest) {
        expect(headOf(html(template)), template).toBe(referenceHead);
      }
    });
  });

  describe('contrast of the theme tokens (WCAG 2.x ratios)', () => {
    const luminance = (hex: string) => {
      const channel = (value: number) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };

    it.each([
      ['light', light],
      ['dark', dark],
    ])('%s: body and secondary text reach AA on the card', (_scheme, theme) => {
      expect(contrast(theme.ink, theme.card)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.muted, theme.card)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.ink, theme.ghost)).toBeGreaterThanOrEqual(4.5);
    });

    it.each([
      ['light', light],
      ['dark', dark],
    ])('%s: accent, CTA and structure stay visible', (_scheme, theme) => {
      // The kicker and the CTA are bold; 3:1 is the floor for large/bold text
      // and for UI boundaries. The light values are the design's own.
      expect(contrast(theme.accent, theme.card)).toBeGreaterThanOrEqual(3);
      expect(contrast(theme.ctaText, theme.cta)).toBeGreaterThanOrEqual(3);
      expect(contrast(theme.rule, theme.card)).toBeGreaterThanOrEqual(3);
      // Decorative separators only need to be distinguishable.
      expect(contrast(theme.hairline, theme.card)).toBeGreaterThanOrEqual(1.2);
      expect(contrast(theme.page, theme.card)).toBeGreaterThanOrEqual(1.15);
    });

    it('lifts the accent for the dark card, where the light accent would fall short', () => {
      expect(contrast(dark.accent, dark.card)).toBeGreaterThanOrEqual(4.5);
      expect(dark.accent).not.toBe(light.accent);
    });

    it('keeps the light tokens the design specified', () => {
      expect(light).toEqual({
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
      });
    });
  });
});
