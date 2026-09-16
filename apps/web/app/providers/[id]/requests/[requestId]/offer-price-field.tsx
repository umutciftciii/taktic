'use client';

import { useEffect, useRef, useState } from 'react';
import { parseLiraToMinor } from '../../../../../lib/lira-input';
import { LiraInput } from '../../../../request-fields/lira-input';

/**
 * The smallest offer the API accepts, in kuruş — one whole lira. Mirrors the
 * DTO's `@Min(100)`; saying it here turns a 400 into a sentence beside the
 * field the provider is still standing in. The API remains the rule.
 */
const MIN_OFFER_MINOR = 100;

/**
 * The offer price, written the way lira are written in Turkey.
 *
 * The same `LiraInput` the customer's budget uses: grouped as it is typed
 * (`4500` → `4.500`), completed when it is left (`4.500,00`), and read back by
 * the server action through `parseLiraToMinor` into the kuruş integer the API
 * has always taken. A text input rather than `type="number"`, which cannot
 * hold `4.500,00` at all; `inputMode="decimal"` keeps the numeric keypad.
 * Required and at-least-one-lira are restated through the validity API so the
 * browser's own `reportValidity()` speaks for them.
 */
export function OfferPriceField() {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const minor = parseLiraToMinor(value);
    ref.current?.setCustomValidity(
      minor !== null && minor < MIN_OFFER_MINOR ? 'En az 1,00 TL girin.' : '',
    );
  }, [value]);

  return (
    <label className="pdash-form-row">
      <span>Teklif tutarı *</span>
      <span className="offer-price-wrap">
        <span className="offer-price-currency" aria-hidden="true">
          ₺
        </span>
        <LiraInput
          ref={ref}
          name="priceAmount"
          value={value}
          onValueChange={setValue}
          required
          testId="offer-price-input"
          placeholder="Örn. 4.500,00"
          className="offer-price-input"
          aria-describedby="offer-price-help"
        />
      </span>
      <small id="offer-price-help">
        Türk lirası. Binlik için nokta otomatik eklenir, kuruş için virgül kullanın: 4.500,00
      </small>
    </label>
  );
}
