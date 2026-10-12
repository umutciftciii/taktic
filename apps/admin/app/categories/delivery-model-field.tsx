import {
  CATEGORY_DELIVERY_MODEL_HINTS,
  CATEGORY_DELIVERY_MODEL_LABELS,
  CATEGORY_DELIVERY_MODELS,
  type CategoryDeliveryModel,
} from '@taktic/shared';
import type { CategoryKind } from '../../lib/api';

/**
 * "Hizmet şekli" on the category forms (MATCH-001): on site, remote or the
 * customer's choice. One control for the create and the edit form.
 *
 * Every model's hint is shown, not only the selected one's: the forms have no
 * script, so a hint tied to the value would go stale the moment the select
 * moves. The help text sits outside the <label> and is tied to the select by
 * `aria-describedby`, so the control's name stays "Hizmet şekli".
 *
 * Shown for every kind, as the price is: the API stores it on any category,
 * but only a service (LEAF) receives requests, so on a group or router the
 * help says it is unused rather than the control disappearing.
 */
export function DeliveryModelField({
  id,
  defaultValue,
  kind,
  existing,
}: {
  /** Unique on the page; the select's id and the help text's id derive from it. */
  id: string;
  defaultValue: CategoryDeliveryModel;
  /** The stored kind on the edit form; null on create, where the kind is still being chosen. */
  kind: CategoryKind | null;
  /** True on the edit form: the change only reaches requests created after it. */
  existing: boolean;
}) {
  const helpId = `${id}-help`;
  return (
    <div className="field field-12" data-testid="category-delivery-model-field">
      <span>
        <label htmlFor={id}>Hizmet şekli *</label>
      </span>
      <select
        id={id}
        name="deliveryModel"
        defaultValue={defaultValue}
        required
        aria-describedby={helpId}
        data-testid="category-delivery-model"
      >
        {CATEGORY_DELIVERY_MODELS.map((model) => (
          <option key={model} value={model}>
            {CATEGORY_DELIVERY_MODEL_LABELS[model]}
          </option>
        ))}
      </select>
      <span className="help-text" id={helpId} data-testid="category-delivery-model-help">
        {kind !== null && kind !== 'LEAF'
          ? 'Yalnız hizmet tipindeki kategorilerde kullanılır; bu tipte talep açılmadığı için yok sayılır. '
          : kind === null
            ? 'Yalnız hizmet tipinde kullanılır. '
            : null}
        {CATEGORY_DELIVERY_MODELS.map((model) => `${CATEGORY_DELIVERY_MODEL_LABELS[model]}: ${CATEGORY_DELIVERY_MODEL_HINTS[model]}`).join(' ')}
        {existing
          ? ' Değişiklik yalnız bundan sonra oluşturulan talepleri etkiler; mevcut talepler oluşturuldukları hizmet şeklini korur.'
          : null}
      </span>
    </div>
  );
}
