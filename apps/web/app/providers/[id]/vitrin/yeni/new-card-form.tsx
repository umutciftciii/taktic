'use client';

import { useState } from 'react';
import type { ShowcaseCardKind } from '../../../../../lib/api';
import { ShowcaseCardFields } from '../showcase-card-fields';

/**
 * The create form's content fields, with the kind selectable.
 *
 * A client component only because the kind decides whether the price field
 * exists at all — a PROMOTION card makes no price claim, so leaving a greyed-out
 * price box on screen would suggest it has one that happens to be empty. Every
 * other field is uncontrolled and posts itself.
 */
export function NewShowcaseCardForm() {
  const [kind, setKind] = useState<ShowcaseCardKind>('SERVICE');

  return <ShowcaseCardFields kind={kind} onKindChange={setKind} />;
}
