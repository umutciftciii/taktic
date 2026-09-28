/**
 * The one reading of a manual credit amount (ADMIN-DESIGN-001 Faz 3B).
 *
 * The form's preview, its confirmation, the server action's payload and the
 * success message all read the typed text through this function, so they
 * cannot disagree about what "1e2" or "2.5" means: neither is an amount.
 *
 * The contract is the API's own, made exact:
 * - `ManualCreditTransactionDto` accepts a positive integer (`@IsInt @Min(1)`).
 * - The ledger stores it in a PostgreSQL `integer` column
 *   (`ProviderCreditTransaction.amount`), so anything above 2 147 483 647 is
 *   refused by the database however valid it looks to the DTO.
 *
 * So the text must be digits only — no sign, no decimal point or comma, no
 * exponent, no inner spaces — and its value must lie in 1…2 147 483 647,
 * which is also inside `Number.MAX_SAFE_INTEGER`, so the number read is the
 * number typed. Surrounding whitespace is ignored; leading zeros are allowed
 * and read as the same number ("050" is 50, and 50 is what is shown and sent).
 */

/** The largest value the ledger's `integer` column can hold. */
export const CREDIT_AMOUNT_MAX = 2_147_483_647;

export type CreditAmountProblem = 'empty' | 'format' | 'range';

export type ParsedCreditAmount = { ok: true; value: number } | { ok: false; problem: CreditAmountProblem };

const DIGITS = /^[0-9]+$/;

export function parseCreditAmount(raw: unknown): ParsedCreditAmount {
  if (typeof raw !== 'string') return { ok: false, problem: raw == null ? 'empty' : 'format' };
  const text = raw.trim();
  if (text === '') return { ok: false, problem: 'empty' };
  if (!DIGITS.test(text)) return { ok: false, problem: 'format' };

  const significant = text.replace(/^0+(?=\d)/, '');
  // More digits than the maximum has is out of range before it is a number,
  // so a 400-digit string never becomes an imprecise float.
  if (significant.length > String(CREDIT_AMOUNT_MAX).length) return { ok: false, problem: 'range' };
  const value = Number(significant);
  if (!Number.isSafeInteger(value) || value < 1 || value > CREDIT_AMOUNT_MAX) {
    return { ok: false, problem: 'range' };
  }
  return { ok: true, value };
}

const maxText = new Intl.NumberFormat('tr-TR').format(CREDIT_AMOUNT_MAX);

/** What the operator is told about an amount that is not one. */
export function creditAmountProblemMessage(problem: CreditAmountProblem): string {
  switch (problem) {
    case 'empty':
      return 'Tutar girin.';
    case 'format':
      return 'Tutar yalnız rakamlardan oluşan bir tam sayı olmalı (örn. 50). Kesir, işaret ve üslü gösterim (1e2) kabul edilmez.';
    case 'range':
      return `Tutar 1 ile ${maxText} arasında olmalı.`;
  }
}
