/**
 * MATCH-001 — the words for how a service is delivered, one copy for the web
 * and admin apps (the API keeps its own enum; it cannot import this package).
 *
 * `CategoryDeliveryModel` is what a category allows; `RequestDeliveryMode` is
 * what one request was created with, and the request's value is the one that
 * decides location matching — a category changed later never moves it.
 */
export type CategoryDeliveryModel = 'ON_SITE' | 'REMOTE' | 'HYBRID';
export type RequestDeliveryMode = 'ON_SITE' | 'REMOTE';

export const CATEGORY_DELIVERY_MODELS: readonly CategoryDeliveryModel[] = ['ON_SITE', 'REMOTE', 'HYBRID'];

export const CATEGORY_DELIVERY_MODEL_LABELS: Record<CategoryDeliveryModel, string> = {
  ON_SITE: 'Yerinde',
  REMOTE: 'Uzaktan',
  HYBRID: 'Hibrit',
};

/** The admin form's help text, one sentence per model. */
export const CATEGORY_DELIVERY_MODEL_HINTS: Record<CategoryDeliveryModel, string> = {
  ON_SITE: 'Hizmet yerinde verilir; hizmet verenin bölgesi dikkate alınır.',
  REMOTE: 'Hizmet uzaktan verilir; hizmet verenin bölgesi dikkate alınmaz.',
  HYBRID: 'Müşteri talep oluştururken yerinde mi uzaktan mı istediğini seçer.',
};

export const REQUEST_DELIVERY_MODE_LABELS: Record<RequestDeliveryMode, string> = {
  ON_SITE: 'Yerinde hizmet',
  REMOTE: 'Uzaktan hizmet',
};

export function isCategoryDeliveryModel(value: unknown): value is CategoryDeliveryModel {
  return value === 'ON_SITE' || value === 'REMOTE' || value === 'HYBRID';
}

export function isRequestDeliveryMode(value: unknown): value is RequestDeliveryMode {
  return value === 'ON_SITE' || value === 'REMOTE';
}

/**
 * The mode a request form will post for this category, when the category
 * decides it alone; null for HYBRID, where the customer must choose. A missing
 * model (an API older than the field) reads as ON_SITE.
 */
export function fixedDeliveryMode(model: CategoryDeliveryModel | null | undefined): RequestDeliveryMode | null {
  if (model === 'HYBRID') return null;
  return model === 'REMOTE' ? 'REMOTE' : 'ON_SITE';
}

/** A request's mode as read from an API response; absent (an older API) is ON_SITE. */
export function requestDeliveryMode(request: { deliveryMode?: string | null }): RequestDeliveryMode {
  return request.deliveryMode === 'REMOTE' ? 'REMOTE' : 'ON_SITE';
}
