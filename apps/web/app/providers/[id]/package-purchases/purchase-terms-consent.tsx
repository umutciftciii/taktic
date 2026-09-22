'use client';

import { useState } from 'react';

/**
 * CMP-006 PR-A. The consent box a credit-package checkout carries while the
 * API's purchase-terms gate is open, and the submit button it unlocks.
 *
 * - **Separate.** It agrees to the purchase terms and nothing else — not
 *   contact sharing, not vitrin pricing, not marketing.
 * - **Unticked by default.** No `defaultChecked`; the state starts false on
 *   every render and nothing from the server can pre-tick it.
 * - **Required.** The button stays disabled until it is ticked, the input is
 *   `required` for a browser without JavaScript, and the API refuses a request
 *   without a literal `true` for the version served — so none of those three
 *   is the only fence.
 *
 * The version travels as a hidden field; the text itself never does. The API
 * stores its own copy of the text it served.
 */
export function PurchaseTermsConsent({
  version,
  buttonLabel,
}: {
  version: string;
  buttonLabel: string;
}) {
  const [accepted, setAccepted] = useState(false);

  return (
    <>
      <input type="hidden" name="termsVersion" value={version} />
      <label className="purchase-terms-consent" data-testid="purchase-terms-consent">
        <input
          type="checkbox"
          name="termsAccepted"
          value="true"
          required
          checked={accepted}
          onChange={(event) => setAccepted(event.target.checked)}
        />
        <span>
          <a href="#satin-alma-kosullari">Satın alma koşullarını</a> (Mesafeli Satış Sözleşmesi, Ön
          Bilgilendirme Formu, Kredi Paketi İade Politikası) okudum ve kabul ediyorum.
        </span>
      </label>
      <button
        className="pdash-btn pdash-btn-primary pdash-btn-block"
        type="submit"
        disabled={!accepted}
        aria-disabled={!accepted}
      >
        {buttonLabel}
      </button>
    </>
  );
}
