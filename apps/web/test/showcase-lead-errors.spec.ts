import { describe, expect, it } from 'vitest';
import { SHOWCASE_LEAD_FAILED, showcaseLeadRefusalText } from '../lib/showcase-lead-errors';

/**
 * The precedence the vitrin lead form applies to a refusal. The case that
 * matters most is the second one: a conflict the API worded for the customer,
 * with no code, has to reach the screen — it used to be swallowed by the
 * generic sentence because the code-less fallback was itself in the table.
 */
describe('showcaseLeadRefusalText', () => {
  it('uses the form’s own sentence for a specific code', () => {
    expect(
      showcaseLeadRefusalText({ code: 'PHONE_VERIFICATION_INVALID', message: 'Invalid code' }),
    ).toBe('Doğrulama kodu geçersiz veya süresi dolmuş. Yeni bir kod isteyebilirsiniz.');
  });

  it('shows the API’s message when the refusal carried no code', () => {
    expect(
      showcaseLeadRefusalText({
        code: SHOWCASE_LEAD_FAILED,
        message: 'Telefon ve e-posta farklı müşteri kayıtlarıyla eşleşiyor.',
      }),
    ).toBe('Telefon ve e-posta farklı müşteri kayıtlarıyla eşleşiyor.');
  });

  it('shows the API’s message for a code the form has no sentence for', () => {
    expect(showcaseLeadRefusalText({ code: 'SOMETHING_NEW', message: 'Yeni bir kural.' })).toBe(
      'Yeni bir kural.',
    );
  });

  it('falls back to the generic sentence only when there is nothing else', () => {
    expect(showcaseLeadRefusalText({ code: SHOWCASE_LEAD_FAILED, message: null })).toBe(
      'Talebiniz gönderilemedi. Bilgileri kontrol edip tekrar deneyin.',
    );
    expect(showcaseLeadRefusalText({ code: 'SOMETHING_NEW', message: '  ' })).toBe(
      'Talebiniz gönderilemedi. Bilgileri kontrol edip tekrar deneyin.',
    );
  });
});
