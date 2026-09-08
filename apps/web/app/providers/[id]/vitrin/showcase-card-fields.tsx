'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import {
  completeLiraAmount,
  formatLiraDraft,
} from '../../../../lib/lira-input';
import type { ShowcaseCardKind } from '../../../../lib/api';

type ShowcaseCardFieldsProps = {
  /** Fixed on an edit; chosen on the create form. */
  kind: ShowcaseCardKind;
  onKindChange?: (kind: ShowcaseCardKind) => void;
  /**
   * The category control, rendered immediately under the kind.
   *
   * A slot rather than a prop pair, because the two forms need genuinely
   * different controls there: the create form picks from a list that depends on
   * the kind, and the edit form has nothing to pick — a card's category is fixed
   * for its life — so it shows what was chosen and says why it cannot change.
   *
   * Its position is the point. The kind decides which categories are on offer,
   * so it has to be answered first and the answer has to be visible while the
   * category is chosen.
   */
  categorySlot?: ReactNode;
  defaultTitle?: string;
  defaultSummary?: string;
  defaultScopeIncluded?: string[];
  defaultScopeExcluded?: string[];
  /** Minor units, as the API stores it. Rendered as lira. */
  defaultPriceMinor?: number | null;
  defaultImageUrl?: string | null;
  defaultUrgentHours?: number;
  defaultNormalHours?: number;
};

/**
 * The content half of a vitrin card form.
 *
 * Two decisions worth stating.
 *
 * **The scope lists are textareas, one item per line.** A dynamic chip editor
 * would be a nicer toy and a worse form: this has to work at 320px, has to
 * survive a page reload with the browser's own field restoration, and has to be
 * pasteable from whatever the provider already wrote down. The server splits on
 * newlines and drops the blanks, so what the field means is exactly what it
 * looks like.
 *
 * **The price field is text, not `type="number"`.** A number input parses its
 * value with a fixed locale and reads `5.000,00` back as empty — the same reason
 * the request form's budget fields are text. `inputMode="decimal"` keeps the
 * numeric keypad on a phone.
 *
 * The price is shown and hidden by kind rather than merely disabled, because a
 * PROMOTION card does not make a price claim at all: leaving a greyed-out price
 * box on screen would suggest it has one that happens to be empty.
 */
export function ShowcaseCardFields({
  kind,
  onKindChange,
  categorySlot,
  defaultTitle = '',
  defaultSummary = '',
  defaultScopeIncluded = [],
  defaultScopeExcluded = [],
  defaultPriceMinor = null,
  defaultImageUrl = null,
  defaultUrgentHours = 3,
  defaultNormalHours = 24,
}: ShowcaseCardFieldsProps) {
  const [price, setPrice] = useState(() => minorToLiraDraft(defaultPriceMinor));
  const priceId = useId();

  // A card switched to PROMOTION carries no price, and the field it was typed
  // into is gone. Clearing the state as well means switching back does not
  // restore a number the provider can no longer see.
  useEffect(() => {
    if (kind === 'PROMOTION') {
      setPrice('');
    }
  }, [kind]);

  return (
    <>
      <section className="pdash-form-section">
        <h2>Kart türü</h2>
        <p className="pdash-form-hint">
          Hizmet vitrini belirli bir hizmeti sabit fiyatla anlatır. Genel tanıtım işletmenizi
          tanıtır; müşteri hizmeti talep açarken seçer ve kart sabit fiyat iddiası taşımaz.
        </p>
        <div className="provider-apply-categories">
          {(['SERVICE', 'PROMOTION'] as const).map((option) => (
            <label className="check-chip" key={option}>
              <input
                type="radio"
                name="kind"
                value={option}
                checked={kind === option}
                onChange={() => onKindChange?.(option)}
                disabled={!onKindChange}
              />
              <span>{option === 'SERVICE' ? 'Hizmet vitrini' : 'Genel tanıtım'}</span>
            </label>
          ))}
        </div>
        {!onKindChange ? (
          <span className="muted" style={{ fontSize: 12 }}>
            Kart türü oluşturulduktan sonra değiştirilemez. Farklı bir tür için yeni kart açın.
          </span>
        ) : null}
      </section>

      {categorySlot}

      <section className="pdash-form-section">
        <h2>Kart içeriği</h2>
        <label className="pdash-form-row">
          <span>Başlık *</span>
          <input name="title" required maxLength={120} defaultValue={defaultTitle} />
        </label>
        <label className="pdash-form-row">
          <span>Özet *</span>
          <textarea name="summary" required maxLength={600} defaultValue={defaultSummary} />
        </label>
        <label className="pdash-form-row">
          <span>Görsel adresi</span>
          <input
            name="imageUrl"
            type="url"
            maxLength={500}
            defaultValue={defaultImageUrl ?? ''}
            placeholder="https://"
          />
          <span className="muted" style={{ fontSize: 12 }}>
            Görseli değiştirmek, kartın yeniden incelenmesini gerektirir.
          </span>
        </label>
      </section>

      <section className="pdash-form-section">
        <h2>Kapsam</h2>
        <p className="pdash-form-hint">
          Her satır bir madde. İkisi de zorunludur: kapsamı yazılmamış bir fiyat, müşterinin
          neye evet dediğini bilmediği bir fiyattır.
        </p>
        <label className="pdash-form-row">
          <span>Dahil olanlar * (her satır bir madde)</span>
          <textarea
            name="scopeIncluded"
            required
            rows={4}
            defaultValue={defaultScopeIncluded.join('\n')}
          />
        </label>
        <label className="pdash-form-row">
          <span>Hariç olanlar * (her satır bir madde)</span>
          <textarea
            name="scopeExcluded"
            required
            rows={4}
            defaultValue={defaultScopeExcluded.join('\n')}
          />
        </label>
      </section>

      {kind === 'SERVICE' ? (
        <section className="pdash-form-section">
          <h2>Hizmet bedeli</h2>
          <p className="pdash-form-hint">
            Bu bedel sizin müşterinize verdiğiniz fiyattır. TakTick bu bedeli tahsil etmez ve
            taraflar arasındaki ödemeye müdahil olmaz.
          </p>
          <label className="pdash-form-row" htmlFor={priceId}>
            <span>Sabit hizmet bedeli (₺) *</span>
            <input
              id={priceId}
              name="listedServicePrice"
              required
              inputMode="decimal"
              autoComplete="off"
              value={price}
              onChange={(event) => setPrice(formatLiraDraft(event.target.value))}
              onBlur={(event) => setPrice(completeLiraAmount(event.target.value))}
            />
          </label>
        </section>
      ) : null}

      <section className="pdash-form-section">
        <h2>Yanıt taahhüdü</h2>
        <p className="pdash-form-hint">
          Vitrin talebi geldiğinde en geç ne kadar sürede gerçek bir yanıt vereceğinizi
          taahhüt edersiniz. Bu taahhüt kartın onaylanan metninin parçasıdır.
        </p>
        <div className="pdash-form-grid">
          <label className="pdash-form-row">
            <span>Acil talep (saat) *</span>
            <input
              name="responseSlaUrgentHours"
              type="number"
              required
              min={1}
              max={24}
              step={1}
              defaultValue={defaultUrgentHours}
            />
          </label>
          <label className="pdash-form-row">
            <span>Normal talep (saat) *</span>
            <input
              name="responseSlaNormalHours"
              type="number"
              required
              min={1}
              max={72}
              step={1}
              defaultValue={defaultNormalHours}
            />
          </label>
        </div>
      </section>
    </>
  );
}

/** Minor units back into the draft string the lira field holds. */
function minorToLiraDraft(minor: number | null): string {
  if (minor === null) return '';
  return formatLiraDraft((minor / 100).toFixed(2).replace('.', ','));
}
