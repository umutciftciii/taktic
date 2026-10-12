import {
  CATEGORY_DELIVERY_MODEL_LABELS,
  fixedDeliveryMode,
  REQUEST_DELIVERY_MODE_LABELS,
  requestDeliveryMode,
} from '@taktic/shared';
import type { KeyValueItem } from '../../../components/key-value-list';
import type { ServiceRequest } from '../../../lib/api';

/**
 * The "Adres ve erişim" rows that say how a request is delivered (MATCH-001).
 *
 * The request's own mode is a snapshot taken when it was created and is the
 * one matching used; the category's model is shown beside it as it is today.
 * The two may differ — the category was changed afterwards — and that is
 * expected, so the note that says so is plain text, never a warning. On a
 * remote request the place is the customer's context only, and the place row
 * says so in words.
 */
export function requestDeliveryItems(
  request: Pick<ServiceRequest, 'deliveryMode' | 'city' | 'district' | 'category'>,
): KeyValueItem[] {
  const mode = requestDeliveryMode(request);
  const categoryModel = request.category.deliveryModel;
  // HYBRID lets the customer choose, so either mode agrees with it.
  const categoryMode = categoryModel ? fixedDeliveryMode(categoryModel) : null;
  const changedSince = categoryMode !== null && categoryMode !== mode;

  return [
    {
      label: 'Hizmet şekli (talep)',
      value: REQUEST_DELIVERY_MODE_LABELS[mode],
      testId: 'request-delivery-mode',
    },
    {
      label: 'Kategori hizmet şekli (bugün)',
      value: categoryModel ? (
        <span className="cell-stack">
          <span>{CATEGORY_DELIVERY_MODEL_LABELS[categoryModel]}</span>
          {changedSince ? (
            <span className="cell-muted" data-testid="request-delivery-category-changed">
              Kategori sonradan değişti; bu talep oluşturulduğu hizmet şeklini korur.
            </span>
          ) : null}
        </span>
      ) : null,
      testId: 'request-delivery-category-model',
    },
    {
      label: 'İl / ilçe',
      value:
        mode === 'REMOTE' ? (
          <span className="cell-stack">
            <span>
              {request.city}/{request.district}
            </span>
            <span className="cell-muted" data-testid="request-delivery-remote-place">
              Uzaktan talep — konum eşleşmede kullanılmaz.
            </span>
          </span>
        ) : (
          `${request.city}/${request.district}`
        ),
      testId: 'request-place',
    },
  ];
}
