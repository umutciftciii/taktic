import { Prisma, ServiceCategoryKind, ServiceCategoryStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  resolveCategorySupplyStatus,
  type CategorySupplyStatus,
} from '../src/modules/categories/category-supply-status';
import {
  canBeSelectedByProviders,
  isProviderEnrollmentOpen,
  providerEnrollmentCategoryWhere,
} from '../src/modules/categories/category-taxonomy';

/**
 * The two derived rules this feature rests on, with no database and no HTTP in
 * the way.
 *
 * The endpoints delegate to them, so pinning the whole matrix here means the
 * integration specs can ask "does the endpoint consult the rule" rather than
 * re-deriving eighteen combinations through supertest.
 */

const { GROUP, LEAF, ROUTER } = ServiceCategoryKind;
const { DRAFT, ACTIVE, INACTIVE } = ServiceCategoryStatus;

const ALL_KINDS = [GROUP, LEAF, ROUTER];
const ALL_STATUSES = [DRAFT, ACTIVE, INACTIVE];

describe('provider enrollment', () => {
  it('opens every ACTIVE leaf, whatever the stored column says', () => {
    expect(
      isProviderEnrollmentOpen({ kind: LEAF, status: ACTIVE, providerEnrollmentOpen: true }),
    ).toBe(true);
    // The one case the column is deliberately powerless over: closing a live
    // category to provider selection would refuse every profile save against
    // it, and no checkbox should be able to do that.
    expect(
      isProviderEnrollmentOpen({ kind: LEAF, status: ACTIVE, providerEnrollmentOpen: false }),
    ).toBe(true);
  });

  it('opens a DRAFT leaf only when an operator has opened it', () => {
    expect(
      isProviderEnrollmentOpen({ kind: LEAF, status: DRAFT, providerEnrollmentOpen: true }),
    ).toBe(true);
    expect(
      isProviderEnrollmentOpen({ kind: LEAF, status: DRAFT, providerEnrollmentOpen: false }),
    ).toBe(false);
  });

  it('never opens a group, a router or a closed category', () => {
    for (const kind of ALL_KINDS) {
      for (const status of ALL_STATUSES) {
        for (const providerEnrollmentOpen of [true, false]) {
          const expected =
            kind === LEAF && (status === ACTIVE || (status === DRAFT && providerEnrollmentOpen));

          expect(isProviderEnrollmentOpen({ kind, status, providerEnrollmentOpen })).toBe(expected);
        }
      }
    }
  });

  it('is the same rule a provider selection is held to', () => {
    for (const kind of ALL_KINDS) {
      for (const status of ALL_STATUSES) {
        for (const providerEnrollmentOpen of [true, false]) {
          const facts = { kind, status, providerEnrollmentOpen };
          expect(canBeSelectedByProviders(facts)).toBe(isProviderEnrollmentOpen(facts));
        }
      }
    }
  });

  /**
   * The SQL twin of the predicate, asserted against it rather than merely
   * spelled next to it: a filter that admits one more row than the predicate is
   * a picker offering a category the API will refuse, and one that admits one
   * fewer is a category a provider may select and can never find.
   */
  it('has a Prisma filter that describes exactly the same set', () => {
    expect(providerEnrollmentCategoryWhere).toEqual<Prisma.ServiceCategoryWhereInput>({
      kind: LEAF,
      OR: [{ status: ACTIVE }, { status: DRAFT, providerEnrollmentOpen: true }],
    });
  });
});

describe('derived supply status', () => {
  it('says nothing about a group, a router or a closed category', () => {
    for (const kind of [GROUP, ROUTER]) {
      for (const status of ALL_STATUSES) {
        expect(
          resolveCategorySupplyStatus({
            kind,
            status,
            offerCreditCost: 5,
            approvedProviderCount: 3,
          }),
        ).toBeNull();
      }
    }

    expect(
      resolveCategorySupplyStatus({
        kind: LEAF,
        status: INACTIVE,
        offerCreditCost: 5,
        approvedProviderCount: 3,
      }),
    ).toBeNull();
  });

  /**
   * A released category is LIVE even with nobody behind it. "Published" is a
   * publishing fact; the missing supply is what the release checklist says, and
   * collapsing the two sentences into one badge is what this status exists to
   * stop.
   */
  it('calls every ACTIVE leaf LIVE, supply or no supply', () => {
    expect(
      resolveCategorySupplyStatus({
        kind: LEAF,
        status: ACTIVE,
        offerCreditCost: null,
        approvedProviderCount: 0,
      }),
    ).toBe<CategorySupplyStatus>('LIVE');
  });

  it('walks a draft from EMPTY to LAUNCH_READY', () => {
    const draft = { kind: LEAF, status: DRAFT } as const;

    expect(
      resolveCategorySupplyStatus({ ...draft, offerCreditCost: 7, approvedProviderCount: 0 }),
    ).toBe<CategorySupplyStatus>('EMPTY');

    expect(
      resolveCategorySupplyStatus({ ...draft, offerCreditCost: null, approvedProviderCount: 1 }),
    ).toBe<CategorySupplyStatus>('SUPPLY_READY');

    expect(
      resolveCategorySupplyStatus({ ...draft, offerCreditCost: 7, approvedProviderCount: 1 }),
    ).toBe<CategorySupplyStatus>('LAUNCH_READY');
  });

  /** Supply first: an unpriced draft with nobody behind it is EMPTY, not SUPPLY_READY. */
  it('reports the missing provider before the missing price', () => {
    expect(
      resolveCategorySupplyStatus({
        kind: LEAF,
        status: DRAFT,
        offerCreditCost: null,
        approvedProviderCount: 0,
      }),
    ).toBe<CategorySupplyStatus>('EMPTY');
  });
});
