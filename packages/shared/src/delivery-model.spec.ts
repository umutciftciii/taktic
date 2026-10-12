import { describe, expect, it } from 'vitest';
import {
  CATEGORY_DELIVERY_MODELS,
  CATEGORY_DELIVERY_MODEL_HINTS,
  CATEGORY_DELIVERY_MODEL_LABELS,
  fixedDeliveryMode,
  isCategoryDeliveryModel,
  isRequestDeliveryMode,
  requestDeliveryMode,
} from './delivery-model';

describe('delivery model', () => {
  it('fixes the mode for ON_SITE and REMOTE, leaves HYBRID to the customer, and reads a missing model as ON_SITE', () => {
    expect(fixedDeliveryMode('ON_SITE')).toBe('ON_SITE');
    expect(fixedDeliveryMode('REMOTE')).toBe('REMOTE');
    expect(fixedDeliveryMode('HYBRID')).toBeNull();
    expect(fixedDeliveryMode(undefined)).toBe('ON_SITE');
    expect(fixedDeliveryMode(null)).toBe('ON_SITE');
  });

  it('reads a request mode defensively', () => {
    expect(requestDeliveryMode({ deliveryMode: 'REMOTE' })).toBe('REMOTE');
    expect(requestDeliveryMode({ deliveryMode: 'ON_SITE' })).toBe('ON_SITE');
    expect(requestDeliveryMode({})).toBe('ON_SITE');
    expect(requestDeliveryMode({ deliveryMode: 'garbage' })).toBe('ON_SITE');
  });

  it('has a label and a hint for every model, and narrows unknown values', () => {
    for (const model of CATEGORY_DELIVERY_MODELS) {
      expect(CATEGORY_DELIVERY_MODEL_LABELS[model]).toBeTruthy();
      expect(CATEGORY_DELIVERY_MODEL_HINTS[model]).toBeTruthy();
      expect(isCategoryDeliveryModel(model)).toBe(true);
    }
    expect(isCategoryDeliveryModel('ONLINE')).toBe(false);
    expect(isRequestDeliveryMode('HYBRID')).toBe(false);
    expect(isRequestDeliveryMode('REMOTE')).toBe(true);
  });
});
