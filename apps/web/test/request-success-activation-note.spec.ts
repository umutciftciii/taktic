import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GuestActivationNote } from '../app/requests/success/activation-note';

/**
 * The activation note on the guest receipt after a request is sent.
 *
 * It is one sentence with one link in the middle of it, and that is exactly
 * what broke: the notice box it sat in is a flex row, so the words before the
 * link, the link and the words after it became three side-by-side columns and
 * the sentence stopped reading as one. The note now renders as prose, and the
 * shape of that markup — one paragraph, one link, nothing else that could be
 * laid out as a column — is what is fixed here. That it wraps as one block at
 * 320px is `e2e/tests/request-success-screen.spec.ts`'s claim.
 *
 * The receipt is also the one screen a visitor with no session sees, so the
 * note may not say anything about the request beyond what it tells them to do.
 */

/** What the note must say, as a reader hears it. */
const SENTENCE =
  'Hesabınızı etkinleştirmeniz için e-posta adresinize bir bağlantı gönderdik. ' +
  'E-postanızı kontrol edin; bağlantı ulaşmadıysa aynı e-posta adresiyle kayıt olmayı deneyin, ' +
  'bağlantı yeniden gönderilir.';

/** Sentences that must never appear on a screen for somebody who is not the owner. */
const CLAIMS = ['yayınlandı', 'yayında', 'ön inceleme', 'onay', 'teklif', 'işletme'];

function textOf(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

describe('the guest activation note', () => {
  const markup = renderToStaticMarkup(createElement(GuestActivationNote));

  it('is one paragraph that reads as the whole sentence', () => {
    expect(markup.startsWith('<p ')).toBe(true);
    expect(markup.endsWith('</p>')).toBe(true);
    expect(markup.match(/<p\b/g)).toHaveLength(1);
    expect(textOf(markup)).toBe(SENTENCE);
  });

  it('is laid out as prose inside the notice box, not as the box’s flex row', () => {
    const classes = markup.match(/^<p[^>]*class="([^"]*)"/)?.[1]?.split(/\s+/) ?? [];
    expect(classes).toContain('notice');
    expect(classes).toContain('notice-prose');
  });

  it('carries the way to a new activation link as the only element inside it', () => {
    const inner = markup.replace(/^<p[^>]*>/, '').replace(/<\/p>$/, '');
    const elements = inner.match(/<[a-z][^>]*>/g) ?? [];
    expect(elements).toHaveLength(1);
    expect(inner).toContain('<a href="/register/customer">kayıt olmayı</a>');
  });

  it('is announced as status and can be found by its test id', () => {
    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-testid="request-success-activation-note"');
  });

  it('claims nothing about the request, the provider or an offer', () => {
    const text = textOf(markup).toLowerCase();
    for (const claim of CLAIMS) {
      expect(text, `the note must not say "${claim}"`).not.toContain(claim);
    }
  });
});
