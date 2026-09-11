'use client';

import type { ShowcaseCard, ShowcaseCardVersion } from '../../../../../lib/api';
import { ShowcaseCardFields } from '../showcase-card-fields';

/**
 * The edit form's content fields, opened on the version being written.
 *
 * The kind is fixed and is passed without a change handler, which is what makes
 * the radio pair read-only on this screen. It is still rendered rather than
 * hidden: a provider editing a PROMOTION card needs to see that they are editing
 * one, and the sentence under it says why they cannot change it here.
 *
 * The kind also travels as a hidden field so the server action can decide
 * whether to send a price at all. Reading it from the disabled radios would send
 * nothing — a disabled control submits no value.
 *
 * The category is shown and not offered. It is fixed for a card's life, so there
 * is nothing here to choose: it lives on the card rather than on a version,
 * which means a change to it could not be put in front of an operator the way
 * every other change is. Showing it read-only says that plainly; leaving it off
 * the form entirely would make a provider wonder where it went.
 */
export function EditShowcaseCardForm({
  card,
  version,
}: {
  card: ShowcaseCard;
  version: ShowcaseCardVersion;
}) {
  return (
    <>
      <input type="hidden" name="kind" value={card.kind} />
      <ShowcaseCardFields
        kind={card.kind}
        categorySlot={
          <label className="pdash-form-row">
            <span>Kategori</span>
            <input value={card.category.name} readOnly disabled />
            <span className="muted" style={{ fontSize: 12 }}>
              Kategori kart oluşturulduktan sonra değiştirilemez. Farklı bir kategori için yeni
              kart açın.
            </span>
          </label>
        }
        defaultTitle={version.title}
        defaultSummary={version.summary}
        defaultScopeIncluded={version.scopeIncluded}
        defaultScopeExcluded={version.scopeExcluded}
        defaultPriceMinor={version.listedServicePriceAmount}
        defaultImageUrl={version.imageUrl}
        defaultUrgentHours={version.responseSlaUrgentHours}
        defaultNormalHours={version.responseSlaNormalHours}
      />
    </>
  );
}
