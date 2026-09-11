'use client';

import { useState } from 'react';
import type { ShowcasePackage, ShowcasePackageTerms } from '../../../../../lib/api';
// From the formatters module, not `lib/api`: this is a client component, and
// `lib/api` reads `next/headers`, which a client bundle cannot carry.
import { formatPrice } from '../../../../../lib/formatters';
import { startShowcasePackageCheckoutAction } from '../actions';

/**
 * Pick a package, agree to the price responsibility, pay. One form.
 *
 * The consent box appears only once a package is chosen and only when this
 * business has not already agreed to the text in force — asking twice for
 * the same consent is how a consent record stops meaning anything. The pay
 * button is inert until the box is ticked, and says why beside it.
 */
export function PackagePicker({
  providerId,
  packages,
  terms,
  returnCard,
}: {
  providerId: string;
  packages: ShowcasePackage[];
  terms: ShowcasePackageTerms | null;
  returnCard: string | null;
}) {
  // A single package is the only sensible choice, so it starts chosen.
  const only = packages.length === 1 ? packages[0] : undefined;
  const [selected, setSelected] = useState<string | null>(only?.id ?? null);
  const [accepted, setAccepted] = useState(false);
  const needsConsent = terms !== null && !terms.accepted;
  const canPay = selected !== null && (!needsConsent || accepted) && terms !== null;

  return (
    <form action={startShowcasePackageCheckoutAction} className="vitrin-form" data-testid="showcase-package-picker">
      <input type="hidden" name="providerId" value={providerId} />
      {returnCard ? <input type="hidden" name="returnCard" value={returnCard} /> : null}

      <fieldset className="vitrin-form-group" style={{ border: 0, margin: 0, minWidth: 0 }}>
        {/* The group's name for assistive tech; the visible heading is plain flow content, because a <legend> cannot hold a <p>. */}
        <legend className="visually-hidden">Paketinizi seçin</legend>
        <div className="vitrin-form-group-head">
          <h2>Paketinizi seçin</h2>
          <p>Süre, kartınız onaylanıp yayına girdiği an başlar.</p>
        </div>
        <div className="vitrin-pkg-grid">
          {packages.map((pkg) => (
            <label className="vitrin-pkg" key={pkg.id} data-testid="showcase-package-option">
              <input
                type="radio"
                name="showcasePackageId"
                value={pkg.id}
                checked={selected === pkg.id}
                onChange={() => setSelected(pkg.id)}
                required
              />
              <p className="vitrin-pkg-name">{pkg.name}</p>
              <p className="vitrin-pkg-price">{formatPrice(pkg.priceAmount, pkg.currency)}</p>
              <p className="vitrin-pkg-meta">
                {pkg.durationDays} gün yayın{pkg.description ? ` · ${pkg.description}` : ''}
              </p>
            </label>
          ))}
        </div>
      </fieldset>

      {selected && needsConsent && terms ? (
        <div className="vitrin-form-group">
          <input type="hidden" name="priceTermsVersion" value={terms.version} />
          <label className="vitrin-consent" data-testid="showcase-package-consent">
            <input
              type="checkbox"
              name="priceTermsAccepted"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            <span>{terms.text}</span>
          </label>
        </div>
      ) : null}

      <div className="vitrin-form-foot" style={{ alignItems: 'center' }}>
        {!canPay ? (
          <p className="vitrin-cta-note" data-testid="showcase-pay-reason">
            {selected === null ? 'Devam etmek için bir paket seçin.' : 'Devam etmek için sorumluluk metnini kabul edin.'}
          </p>
        ) : null}
        <button className="pdash-btn pdash-btn-primary" type="submit" disabled={!canPay} data-testid="showcase-pay">
          Güvenli ödemeye geç
        </button>
      </div>
    </form>
  );
}
