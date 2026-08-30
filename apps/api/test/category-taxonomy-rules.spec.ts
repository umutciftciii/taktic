import {
  QuestionConditionMatchMode,
  ServiceCategoryKind,
  ServiceCategoryStatus,
  ServiceRequestQuestionSystemField,
  ServiceRequestQuestionType,
} from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  canBeAssignedByAdmin,
  canBeSelectedByProviders,
  canEnterFlow,
  canReceiveRequests,
  isActiveFor,
  isLiveProviderBinding,
  isPubliclyListable,
  isPubliclyReachable,
} from '../src/modules/categories/category-taxonomy';
import {
  assertSystemFieldTypeMatches,
  hasSystemFieldValue,
} from '../src/modules/questions/question-system-fields';
import {
  conditionHolds,
  resolveVisibleQuestionIds,
} from '../src/modules/questions/question-visibility';

/**
 * The permission matrix and the visibility engine, with no database and no HTTP
 * in the way.
 *
 * These are the rules the endpoints delegate to, so pinning them here means the
 * integration specs can concentrate on "does the endpoint ask" rather than
 * re-deriving nine kind × status combinations through supertest.
 */

const { GROUP, LEAF, ROUTER } = ServiceCategoryKind;
const { DRAFT, ACTIVE, INACTIVE } = ServiceCategoryStatus;

const ALL_KINDS = [GROUP, LEAF, ROUTER];
const ALL_STATUSES = [DRAFT, ACTIVE, INACTIVE];

describe('category access matrix', () => {
  it('lists only ACTIVE leaves publicly', () => {
    for (const kind of ALL_KINDS) {
      for (const status of ALL_STATUSES) {
        expect(isPubliclyListable({ kind, status })).toBe(kind === LEAF && status === ACTIVE);
      }
    }
  });

  it('serves an ACTIVE router by slug, so a routed flow can begin, but never a group', () => {
    expect(isPubliclyReachable({ kind: ROUTER, status: ACTIVE })).toBe(true);
    expect(isPubliclyReachable({ kind: LEAF, status: ACTIVE })).toBe(true);
    expect(isPubliclyReachable({ kind: GROUP, status: ACTIVE })).toBe(false);
    expect(isPubliclyReachable({ kind: ROUTER, status: DRAFT })).toBe(false);
    expect(isPubliclyReachable({ kind: LEAF, status: INACTIVE })).toBe(false);
  });

  it('opens DRAFT to an admin only, and INACTIVE to nobody', () => {
    expect(canEnterFlow({ kind: LEAF, status: DRAFT }, false)).toBe(false);
    expect(canEnterFlow({ kind: LEAF, status: DRAFT }, true)).toBe(true);

    // Closed means closed. An admin who wants requests again reactivates the
    // category rather than working around the state.
    expect(canEnterFlow({ kind: LEAF, status: INACTIVE }, false)).toBe(false);
    expect(canEnterFlow({ kind: LEAF, status: INACTIVE }, true)).toBe(false);

    // A group is a folder in every state: there is no request to open on it.
    expect(canEnterFlow({ kind: GROUP, status: ACTIVE }, true)).toBe(false);
  });

  it('lands a request only on a leaf, whoever is asking', () => {
    expect(canReceiveRequests({ kind: ROUTER, status: ACTIVE }, true)).toBe(false);
    expect(canReceiveRequests({ kind: GROUP, status: ACTIVE }, true)).toBe(false);
    expect(canReceiveRequests({ kind: LEAF, status: ACTIVE }, false)).toBe(true);
    expect(canReceiveRequests({ kind: LEAF, status: DRAFT }, true)).toBe(true);
  });

  it('lets a provider select nothing but an ACTIVE leaf while enrollment is closed', () => {
    for (const kind of ALL_KINDS) {
      for (const status of ALL_STATUSES) {
        // A live service is selectable whatever the enrollment column says; a
        // draft only once an operator opens it. The full matrix lives in
        // category-supply-status.spec.ts.
        expect(canBeSelectedByProviders({ kind, status, providerEnrollmentOpen: false })).toBe(
          kind === LEAF && status === ACTIVE,
        );
      }
    }
  });

  it('lets an operator assign an ACTIVE or a DRAFT leaf, and nothing else', () => {
    for (const kind of ALL_KINDS) {
      for (const status of ALL_STATUSES) {
        expect(canBeAssignedByAdmin({ kind, status })).toBe(
          kind === LEAF && status !== INACTIVE,
        );
      }
    }

    // The one place the operator's reach is wider than a provider's, stated as
    // the difference between the two rules rather than as a second matrix.
    expect(canBeAssignedByAdmin({ kind: LEAF, status: DRAFT })).toBe(true);
    expect(
      canBeSelectedByProviders({ kind: LEAF, status: DRAFT, providerEnrollmentOpen: false }),
    ).toBe(false);
    // The operator's reach is wider only while the draft is closed. Opening it
    // is what lets a business reach the same category on its own.
    expect(
      canBeSelectedByProviders({ kind: LEAF, status: DRAFT, providerEnrollmentOpen: true }),
    ).toBe(true);
  });

  it('counts every binding as live supply except a draft one', () => {
    expect(isLiveProviderBinding({ status: ACTIVE })).toBe(true);
    // Not excluded: closing a category is already handled by the rules that
    // refuse new requests and new offers, and rewriting what an existing
    // binding means would change behaviour nothing asked to change.
    expect(isLiveProviderBinding({ status: INACTIVE })).toBe(true);
    expect(isLiveProviderBinding({ status: DRAFT })).toBe(false);
  });

  it('keeps the legacy isActive boolean in step with the status', () => {
    expect(isActiveFor(ACTIVE)).toBe(true);
    expect(isActiveFor(DRAFT)).toBe(false);
    expect(isActiveFor(INACTIVE)).toBe(false);
  });
});

describe('question visibility', () => {
  const source = {
    id: 'q-source',
    key: 'tip',
    type: ServiceRequestQuestionType.SELECT,
    sortOrder: 10,
    conditions: [],
  };

  const dependent = {
    id: 'q-dependent',
    key: 'detay',
    type: ServiceRequestQuestionType.MULTI_SELECT,
    sortOrder: 20,
    conditions: [{ sourceQuestionId: 'q-source', expectedValues: ['komple'] }],
  };

  it('shows an unconditional question whatever was answered', () => {
    expect(resolveVisibleQuestionIds([source], new Map())).toEqual(new Set(['q-source']));
  });

  it('hides a dependent question until its trigger is chosen', () => {
    const answers = new Map<string, unknown>([['q-source', 'fayans']]);
    expect(resolveVisibleQuestionIds([source, dependent], answers)).toEqual(new Set(['q-source']));
  });

  it('shows it on the expected answer', () => {
    const answers = new Map<string, unknown>([['q-source', 'komple']]);
    expect(resolveVisibleQuestionIds([source, dependent], answers)).toEqual(
      new Set(['q-source', 'q-dependent']),
    );
  });

  it('matches a MULTI_SELECT source by intersection', () => {
    const multiSource = { ...source, type: ServiceRequestQuestionType.MULTI_SELECT };
    const answers = new Map<string, unknown>([['q-source', ['baska', 'komple']]]);

    expect(resolveVisibleQuestionIds([multiSource, dependent], answers)).toEqual(
      new Set(['q-source', 'q-dependent']),
    );
  });

  it('ANDs several conditions on one question', () => {
    const second = {
      id: 'q-second',
      key: 'ikinci',
      type: ServiceRequestQuestionType.SELECT,
      sortOrder: 15,
      conditions: [],
    };
    const both = {
      ...dependent,
      conditions: [
        { sourceQuestionId: 'q-source', expectedValues: ['komple'] },
        { sourceQuestionId: 'q-second', expectedValues: ['evet'] },
      ],
    };

    const onlyFirst = new Map<string, unknown>([
      ['q-source', 'komple'],
      ['q-second', 'hayir'],
    ]);
    expect(resolveVisibleQuestionIds([source, second, both], onlyFirst).has('q-dependent')).toBe(
      false,
    );

    const bothAnswers = new Map<string, unknown>([
      ['q-source', 'komple'],
      ['q-second', 'evet'],
    ]);
    expect(resolveVisibleQuestionIds([source, second, both], bothAnswers).has('q-dependent')).toBe(
      true,
    );
  });

  it('hides a question whose source is itself hidden, however that source was answered', () => {
    // A two-level chain: `detay` depends on `tip`, and `ek` depends on `detay`.
    // An answer left behind on `detay` from before `tip` changed must not light
    // `ek` up again.
    const chained = {
      id: 'q-chained',
      key: 'ek',
      type: ServiceRequestQuestionType.SELECT,
      sortOrder: 30,
      conditions: [{ sourceQuestionId: 'q-dependent', expectedValues: ['fayans'] }],
    };

    const stale = new Map<string, unknown>([
      ['q-source', 'fayans'],
      ['q-dependent', ['fayans']],
    ]);

    const visible = resolveVisibleQuestionIds([source, dependent, chained], stale);
    expect(visible.has('q-dependent')).toBe(false);
    expect(visible.has('q-chained')).toBe(false);
  });
});

describe('condition match modes', () => {
  const expected = ['tesisat', 'dolap'];

  it('defaults to ANY when the rule does not say, which is what every legacy rule means', () => {
    // No `matchMode` at all: the shape of every condition stored before the
    // column existed, and of one a caller builds by hand.
    const legacy = { sourceQuestionId: 'q', expectedValues: expected };

    expect(conditionHolds(legacy, ['tesisat'])).toBe(true);
    expect(conditionHolds(legacy, ['dolap'])).toBe(true);
    expect(conditionHolds(legacy, ['kapi'])).toBe(false);
  });

  it('ANY is satisfied by one of the expected answers', () => {
    const any = {
      sourceQuestionId: 'q',
      expectedValues: expected,
      matchMode: QuestionConditionMatchMode.ANY,
    };

    expect(conditionHolds(any, ['tesisat', 'kapi'])).toBe(true);
    expect(conditionHolds(any, [])).toBe(false);
    expect(conditionHolds(any, ['kapi'])).toBe(false);
  });

  it('ALL needs every expected answer, and tolerates extra ones', () => {
    const all = {
      sourceQuestionId: 'q',
      expectedValues: expected,
      matchMode: QuestionConditionMatchMode.ALL,
    };

    expect(conditionHolds(all, ['tesisat', 'dolap'])).toBe(true);
    // Extra choices do not spoil it: the rule is about what is present.
    expect(conditionHolds(all, ['tesisat', 'dolap', 'kapi'])).toBe(true);
    // One of the two is not both of them.
    expect(conditionHolds(all, ['tesisat'])).toBe(false);
    expect(conditionHolds(all, [])).toBe(false);
  });

  it('reads a single-value answer as the one-element set it is', () => {
    const oneExpected = {
      sourceQuestionId: 'q',
      expectedValues: ['komple'],
      matchMode: QuestionConditionMatchMode.ALL,
    };

    expect(conditionHolds(oneExpected, 'komple')).toBe(true);
    expect(conditionHolds(oneExpected, 'fayans')).toBe(false);
  });

  it('drives the visibility pass, so an ALL rule hides its question until the set is complete', () => {
    const source = {
      id: 'q-source',
      key: 'isler',
      type: ServiceRequestQuestionType.MULTI_SELECT,
      sortOrder: 10,
      conditions: [],
    };
    const dependent = {
      id: 'q-dependent',
      key: 'detay',
      type: ServiceRequestQuestionType.TEXT,
      sortOrder: 20,
      conditions: [
        {
          sourceQuestionId: 'q-source',
          expectedValues: expected,
          matchMode: QuestionConditionMatchMode.ALL,
        },
      ],
    };

    const partial = new Map<string, unknown>([['q-source', ['tesisat']]]);
    expect(resolveVisibleQuestionIds([source, dependent], partial).has('q-dependent')).toBe(false);

    const complete = new Map<string, unknown>([['q-source', ['tesisat', 'dolap']]]);
    expect(resolveVisibleQuestionIds([source, dependent], complete).has('q-dependent')).toBe(true);
  });
});

describe('system field bindings', () => {
  const base = {
    city: 'İstanbul',
    district: 'Kadıköy',
    neighborhood: null,
    budgetMin: null,
    budgetMax: null,
    description: null,
    preferredDate: null,
  };

  it('reads the address binding as "the neighbourhood too", since city and district are always required', () => {
    expect(hasSystemFieldValue(ServiceRequestQuestionSystemField.ADDRESS, base)).toBe(false);
    expect(
      hasSystemFieldValue(ServiceRequestQuestionSystemField.ADDRESS, {
        ...base,
        neighborhood: 'Caferağa',
      }),
    ).toBe(true);
  });

  it('accepts either end of a budget range', () => {
    expect(hasSystemFieldValue(ServiceRequestQuestionSystemField.BUDGET, base)).toBe(false);
    expect(
      hasSystemFieldValue(ServiceRequestQuestionSystemField.BUDGET, { ...base, budgetMax: 500_00 }),
    ).toBe(true);
  });

  it('treats a blank description as no description', () => {
    expect(
      hasSystemFieldValue(ServiceRequestQuestionSystemField.DESCRIPTION, {
        ...base,
        description: '   ',
      }),
    ).toBe(false);
    expect(
      hasSystemFieldValue(ServiceRequestQuestionSystemField.DESCRIPTION, {
        ...base,
        description: 'Banyo yenilenecek',
      }),
    ).toBe(true);
  });

  it('refuses a binding the question type could not carry', () => {
    expect(() =>
      assertSystemFieldTypeMatches(
        ServiceRequestQuestionSystemField.BUDGET,
        ServiceRequestQuestionType.SELECT,
      ),
    ).toThrow(/NUMBER/);

    expect(() =>
      assertSystemFieldTypeMatches(
        ServiceRequestQuestionSystemField.DESCRIPTION,
        ServiceRequestQuestionType.TEXTAREA,
      ),
    ).not.toThrow();

    expect(() =>
      assertSystemFieldTypeMatches(null, ServiceRequestQuestionType.SELECT),
    ).not.toThrow();
  });
});
