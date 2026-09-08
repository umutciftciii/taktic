'use client';

import { useState } from 'react';
import type { ShowcaseCardKind, ShowcaseEligibleCategories } from '../../../../../lib/api';
import { ShowcaseCardFields } from '../showcase-card-fields';

/**
 * The create form's kind, category and content fields.
 *
 * A client component for one reason with two consequences: the kind decides both
 * whether the price field exists at all and *which categories may be chosen*.
 * A general card may sit on a shelf — a group above the services this business
 * performs — and a service card may not, so the two lists are genuinely
 * different and the select has to follow the radio.
 *
 * Both lists come from the API. This component never derives eligibility: it
 * does not know the category tree, and a client that guessed at it would be a
 * client deciding what a business is allowed to advertise. The write endpoint
 * re-derives the same rule and refuses anything outside it, so what happens here
 * is convenience.
 *
 * Switching kind clears a category the new kind does not offer. Silently keeping
 * a group selected while the form flipped to SERVICE would post a value the API
 * is about to refuse, and the provider would be told about a choice the screen
 * no longer shows them.
 */
export function NewShowcaseCardForm({
  categories,
}: {
  categories: ShowcaseEligibleCategories;
}) {
  const [kind, setKind] = useState<ShowcaseCardKind>('SERVICE');
  const [categoryId, setCategoryId] = useState('');

  const options = kind === 'SERVICE' ? categories.service : categories.promotion;

  function changeKind(next: ShowcaseCardKind) {
    setKind(next);
    const offered = next === 'SERVICE' ? categories.service : categories.promotion;
    if (!offered.some((category) => category.id === categoryId)) {
      setCategoryId('');
    }
  }

  return (
    <ShowcaseCardFields
      kind={kind}
      onKindChange={changeKind}
      categorySlot={
        <section className="pdash-form-section">
          <h2>Hizmet kategorisi</h2>
          <p className="pdash-form-hint">
            {kind === 'PROMOTION'
              ? 'Genel tanıtım kartını tek bir hizmete ya da altında hizmet verdiğiniz bir gruba bağlayabilirsiniz.'
              : 'Hizmet vitrini kartı tek bir hizmete bağlanır.'}{' '}
            Kategori kart oluşturulduktan sonra değiştirilemez; farklı bir kategori için yeni
            kart açın.
          </p>
          <label className="pdash-form-row">
            <span>Kategori *</span>
            <select
              name="categoryId"
              required
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
              data-testid="showcase-category-select"
            >
              <option value="" disabled>
                Seçiniz
              </option>
              {options.map((category) => (
                <option key={category.id} value={category.id}>
                  {/*
                    Indented with a fixed-width space rather than nested
                    <optgroup>: a group here is a selectable option for a general
                    card, and an optgroup label is not selectable.
                  */}
                  {'  '.repeat(category.depth)}
                  {category.name}
                  {category.kind === 'GROUP' ? ' (grup)' : ''}
                </option>
              ))}
            </select>
          </label>
          {options.length === 0 ? (
            <span className="muted" style={{ fontSize: 12 }}>
              Bu kart türü için uygun kategoriniz yok. İşletme profilinizde talep alabilen bir
              hizmet seçtiğinizde burada görünür.
            </span>
          ) : null}
        </section>
      }
    />
  );
}
