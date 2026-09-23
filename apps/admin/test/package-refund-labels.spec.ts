import { describe, expect, it } from 'vitest';
import {
  adminPermissionLabel,
  PACKAGE_REFUND_STATUS_LABELS,
  PACKAGE_REFUND_STATUSES,
  packageRefundStatusBadgeClass,
} from '../lib/api';
import { navGroups } from '../lib/nav';

/**
 * CMP-006 PR-B — the operator's words for the package refund queue.
 *
 * The three permissions land in their own area of the role matrix with a
 * readable action each (the generic splitter would have named the last two by
 * their raw codes), every status has a label and a badge, and the queue's
 * sidebar row is behind its own permission rather than PACKAGE_PURCHASES_READ.
 */
describe('package refund labels', () => {
  it('names the three permissions as one area with maker/checker actions', () => {
    expect(adminPermissionLabel('PACKAGE_REFUND_READ')).toEqual({ area: 'Paket iadeleri', action: 'okuma' });
    expect(adminPermissionLabel('PACKAGE_REFUND_REQUEST_CREATE')).toEqual({
      area: 'Paket iadeleri',
      action: 'talep açma ve işleme alma',
    });
    expect(adminPermissionLabel('PACKAGE_REFUND_APPROVE')).toEqual({
      area: 'Paket iadeleri',
      action: 'onay, ret ve mutabakat kaydı',
    });
    // Unchanged for the neighbours.
    expect(adminPermissionLabel('PACKAGE_PURCHASES_READ').area).toBe('Paket satın almaları');
  });

  it('labels and colours every status', () => {
    for (const status of PACKAGE_REFUND_STATUSES) {
      expect(PACKAGE_REFUND_STATUS_LABELS[status]).toBeTruthy();
      expect(packageRefundStatusBadgeClass(status)).toMatch(/^badge /);
    }
    expect(packageRefundStatusBadgeClass('SETTLED')).toBe('badge badge-good');
  });

  it('puts the queue in the sidebar behind PACKAGE_REFUND_READ', () => {
    const item = navGroups.flatMap((group) => group.items).find((entry) => entry.href === '/package-refunds');
    expect(item).toMatchObject({ label: 'Paket İadeleri', permission: 'PACKAGE_REFUND_READ' });
  });
});
