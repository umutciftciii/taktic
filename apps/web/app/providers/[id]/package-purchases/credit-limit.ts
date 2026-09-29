import { ApiError, formatPrice, type PackagePurchase } from '../../../../lib/api';

/**
 * API-HARDENING-001: whether an API refusal is the ledger's balance bound
 * (`CREDIT_BALANCE_LIMIT_EXCEEDED`). The API answers it before a payment page
 * opens and again at the mock settlement; either way nothing was charged or
 * loaded. Kept out of the `'use server'` action files so it is not itself an
 * action.
 */
export function isCreditBalanceLimitRefusal(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 400) {
    return false;
  }
  try {
    return (JSON.parse(error.body) as { code?: unknown }).code === 'CREDIT_BALANCE_LIMIT_EXCEEDED';
  } catch {
    return false;
  }
}

/**
 * How a purchase with a credit hold reads on the provider's own screens
 * (API-HARDENING-001). The API keeps such a purchase PENDING — no credit was
 * loaded — but the money was captured, so it must never look like an unpaid
 * checkout or be offered for payment again. Null for every other purchase,
 * including one whose hold settled (it reads PAID like any other).
 */
export function purchaseCreditHoldView(purchase: Pick<PackagePurchase, 'creditHold'>) {
  const hold = purchase.creditHold;
  if (!hold || hold.status === 'SETTLED') {
    return null;
  }
  const charged = formatPrice(hold.chargedAmountMinor, hold.currency);
  if (hold.status === 'OPEN') {
    return {
      /** Payment actions are withheld: this purchase is paid for. */
      blocksPayment: true,
      label: 'Ödendi · kredi beklemede',
      tone: 'warn' as const,
      title: 'Ödemeniz alındı; kredileriniz beklemede',
      text:
        `${charged} tutarındaki ödemeniz alındı. Bu paketin ${hold.creditAmount} kredisi, bakiyeniz kredi üst ` +
        'sınırını aşacağı için henüz yüklenmedi. Ekibimiz bu ödemeyi inceliyor: krediler yüklenecek ya da ödemeniz ' +
        'iade edilecek. Bu paketi yeniden satın almanıza gerek yok.',
    };
  }
  return {
    blocksPayment: true,
    label: 'İade edildi',
    tone: 'info' as const,
    title: 'Ödemeniz iade edildi',
    text: `${charged} tutarındaki ödemeniz iade edildi; bu satın alma için kredi yüklenmedi.`,
  };
}
