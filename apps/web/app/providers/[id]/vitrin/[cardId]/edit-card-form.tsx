'use client';

import type { ShowcaseCardKind, ShowcaseCardVersion } from '../../../../../lib/api';
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
 */
export function EditShowcaseCardForm({
  kind,
  version,
}: {
  kind: ShowcaseCardKind;
  version: ShowcaseCardVersion;
}) {
  return (
    <>
      <input type="hidden" name="kind" value={kind} />
      <ShowcaseCardFields
        kind={kind}
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
