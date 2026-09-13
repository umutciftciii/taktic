import { describe, expect, it } from 'vitest';
import { REQUEST_REFUSAL_GENERIC, requestRefusalText } from '../lib/request-refusal-text';

/**
 * The precedence the vitrin lead form applies to a refusal. The case that
 * matters most is the second one: a conflict the API worded for the customer,
 * with no code, has to reach the screen — it used to be swallowed by the
 * generic sentence because the code-less fallback was itself in the table.
 */
describe('requestRefusalText', () => {
  it('uses the form’s own sentence for a specific code', () => {
    expect(
      requestRefusalText({ code: 'PHONE_VERIFICATION_INVALID', message: 'Invalid code' }),
    ).toBe('Doğrulama kodu geçersiz veya süresi dolmuş. Yeni bir kod isteyebilirsiniz.');
  });

  it('shows the API’s message when the refusal carried no code', () => {
    expect(
      requestRefusalText({
        code: REQUEST_REFUSAL_GENERIC,
        message: 'Telefon ve e-posta farklı müşteri kayıtlarıyla eşleşiyor.',
      }),
    ).toBe('Telefon ve e-posta farklı müşteri kayıtlarıyla eşleşiyor.');
  });

  it('shows the API’s message for a code the form has no sentence for', () => {
    expect(requestRefusalText({ code: 'SOMETHING_NEW', message: 'Yeni bir kural.' })).toBe(
      'Yeni bir kural.',
    );
  });

  it('falls back to the generic sentence only when there is nothing else', () => {
    expect(requestRefusalText({ code: REQUEST_REFUSAL_GENERIC, message: null })).toBe(
      'Talebiniz gönderilemedi. Bilgileri kontrol edip tekrar deneyin.',
    );
    expect(requestRefusalText({ code: 'SOMETHING_NEW', message: '  ' })).toBe(
      'Talebiniz gönderilemedi. Bilgileri kontrol edip tekrar deneyin.',
    );
  });

  it('names the identity conflict in the product’s words', () => {
    expect(
      requestRefusalText({
        code: 'CUSTOMER_IDENTITY_CONFLICT',
        message: 'Telefon ve e-posta farklı müşteri kayıtlarıyla eşleşiyor.',
      }),
    ).toBe(
      'Bu telefon numarası ve e-posta iki farklı müşteri hesabına bağlı. Tek bir hesaba ait iletişim bilgileriyle devam edin.',
    );
  });
});
