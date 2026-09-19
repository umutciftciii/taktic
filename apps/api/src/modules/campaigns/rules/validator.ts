import {
  CAMPAIGN_BENEFIT,
  CAMPAIGN_CONDITIONS,
  CAMPAIGN_ELIGIBILITY_TRIGGER,
  CAMPAIGN_FACTS,
  CAMPAIGN_FACT_SET,
  CAMPAIGN_GROUP_LIMITS,
  CAMPAIGN_LIMITS,
  CAMPAIGN_PRIORITY,
  CAMPAIGN_RULES_SCHEMA_VERSION,
  CAMPAIGN_STACK_POLICIES,
  CAMPAIGN_TRIGGERS,
  type ArgumentSpec,
  type ConditionSpec,
} from './catalog';
import {
  CAMPAIGN_RULE_ERROR_MESSAGES,
  type CampaignRuleError,
  type CampaignRuleErrorCode,
} from './errors';
import type {
  CampaignAnyGroup,
  CampaignCondition,
  CampaignDefinition,
  CampaignDefinitionSummary,
} from './types';

/**
 * The single authority on what a campaign definition may say.
 *
 * Pure and deterministic: the same input always yields the same errors in the
 * same order, or the same normalised definition. It reads nothing but the
 * catalogue. The one fact it cannot know on its own — whether a package slug
 * exists — is passed in by the caller as a set, so a unit test and the admin
 * service exercise exactly the same code.
 *
 * It refuses rather than repairs. An unknown field is an error, not something
 * to drop; a string where an integer belongs is an error, not something to
 * coerce. What comes out is what went in, minus nothing and plus explicit
 * nulls for the optional limits and window bounds — so a stored definition can
 * be compared field by field with the next one.
 */

export type ValidateCampaignDefinitionOptions = {
  /**
   * Every package slug that exists in the catalogue. When omitted the slug
   * existence check is skipped (the structural checks still run); the service
   * always supplies it.
   */
  knownPackageSlugs?: ReadonlySet<string> | null;
};

export type CampaignDefinitionValidation =
  | { ok: true; definition: CampaignDefinition; summary: CampaignDefinitionSummary }
  | { ok: false; errors: CampaignRuleError[] };

const TOP_LEVEL_FIELDS = new Set([
  'schemaVersion',
  'trigger',
  'eligibility',
  'conditions',
  'benefit',
  'limits',
  'window',
  'stackPolicy',
  'priority',
]);

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SLUG_MAX_LENGTH = 80;
const ISO_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

class Errors {
  readonly list: CampaignRuleError[] = [];

  add(path: string, code: CampaignRuleErrorCode, detail?: string) {
    const base = CAMPAIGN_RULE_ERROR_MESSAGES[code];
    this.list.push({ path, code, message: detail ? `${base} ${detail}` : base });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIntegerWithin(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function rejectUnknownFields(
  object: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string,
  errors: Errors,
) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      errors.add(prefix ? `${prefix}.${key}` : key, 'UNKNOWN_FIELD');
    }
  }
}

export function validateCampaignDefinition(
  input: unknown,
  options: ValidateCampaignDefinitionOptions = {},
): CampaignDefinitionValidation {
  const errors = new Errors();

  if (!isPlainObject(input)) {
    errors.add('', 'SCHEMA_INVALID');
    return { ok: false, errors: errors.list };
  }

  rejectUnknownFields(input, TOP_LEVEL_FIELDS, '', errors);

  if (input.schemaVersion !== CAMPAIGN_RULES_SCHEMA_VERSION) {
    errors.add('schemaVersion', 'UNSUPPORTED_SCHEMA_VERSION');
  }

  const trigger = typeof input.trigger === 'string' && CAMPAIGN_TRIGGERS.includes(input.trigger)
    ? input.trigger
    : null;
  if (trigger === null) {
    errors.add('trigger', 'UNKNOWN_TRIGGER');
  }

  const facts = validateEligibility(input.eligibility, trigger, errors);
  const conditions = validateConditions(input.conditions, trigger, facts, options, errors);
  const benefit = validateBenefit(input.benefit, errors);
  const limits = validateLimits(input.limits, benefit?.credits ?? null, errors);
  const window = validateWindow(input.window, errors);

  const stackPolicy =
    typeof input.stackPolicy === 'string' && CAMPAIGN_STACK_POLICIES.includes(input.stackPolicy)
      ? input.stackPolicy
      : null;
  if (stackPolicy === null) {
    errors.add('stackPolicy', 'STACK_POLICY_INVALID');
  }

  const priority = isIntegerWithin(input.priority, CAMPAIGN_PRIORITY.min, CAMPAIGN_PRIORITY.max)
    ? input.priority
    : null;
  if (priority === null) {
    errors.add('priority', 'PRIORITY_INVALID');
  }

  if (
    errors.list.length > 0 ||
    trigger === null ||
    conditions === null ||
    benefit === null ||
    limits === null ||
    window === null ||
    stackPolicy === null ||
    priority === null
  ) {
    return { ok: false, errors: errors.list };
  }

  const isEligibility = trigger === CAMPAIGN_ELIGIBILITY_TRIGGER;
  const sortedFacts = isEligibility && facts ? [...facts].sort() : [];

  const definition: CampaignDefinition = {
    schemaVersion: 1,
    trigger,
    ...(isEligibility ? { eligibility: { facts: sortedFacts } } : {}),
    conditions: { all: conditions },
    benefit,
    limits,
    window,
    stackPolicy,
    priority,
  };

  const summary: CampaignDefinitionSummary = {
    trigger,
    factSetKey: isEligibility ? sortedFacts.join('+') : null,
    eligibilityFacts: sortedFacts,
    conditionCount: conditions.reduce(
      (count, entry) => count + ('any' in entry ? entry.any.length : 1),
      0,
    ),
    benefitCredits: benefit.credits,
    benefitExpiresInDays: benefit.expiresInDays,
  };

  return { ok: true, definition, summary };
}

/** Returns the fact list when it is structurally sound, or null. */
function validateEligibility(
  value: unknown,
  trigger: string | null,
  errors: Errors,
): string[] | null {
  if (trigger === null) {
    return null;
  }

  if (trigger !== CAMPAIGN_ELIGIBILITY_TRIGGER) {
    if (value !== undefined) {
      errors.add('eligibility', 'ELIGIBILITY_NOT_ALLOWED');
    }
    return null;
  }

  if (value === undefined) {
    errors.add('eligibility', 'ELIGIBILITY_REQUIRED');
    return null;
  }
  if (!isPlainObject(value)) {
    errors.add('eligibility', 'SCHEMA_INVALID');
    return null;
  }
  rejectUnknownFields(value, new Set(['facts']), 'eligibility', errors);

  if (!Array.isArray(value.facts)) {
    errors.add('eligibility.facts', 'SCHEMA_INVALID');
    return null;
  }

  const seen = new Set<string>();
  let sound = true;
  value.facts.forEach((fact, index) => {
    const path = `eligibility.facts[${index}]`;
    if (typeof fact !== 'string' || !CAMPAIGN_FACTS.includes(fact)) {
      errors.add(path, 'UNKNOWN_FACT');
      sound = false;
      return;
    }
    if (seen.has(fact)) {
      errors.add(path, 'DUPLICATE_FACT');
      sound = false;
      return;
    }
    seen.add(fact);
  });

  if (seen.size < CAMPAIGN_FACT_SET.min || seen.size > CAMPAIGN_FACT_SET.max) {
    errors.add(
      'eligibility.facts',
      'FACT_SET_SIZE',
      `(${CAMPAIGN_FACT_SET.min}–${CAMPAIGN_FACT_SET.max} olgu)`,
    );
    sound = false;
  }

  return sound ? [...seen] : null;
}

function validateConditions(
  value: unknown,
  trigger: string | null,
  facts: string[] | null,
  options: ValidateCampaignDefinitionOptions,
  errors: Errors,
): Array<CampaignCondition | CampaignAnyGroup> | null {
  if (!isPlainObject(value)) {
    errors.add('conditions', 'SCHEMA_INVALID');
    return null;
  }
  rejectUnknownFields(value, new Set(['all']), 'conditions', errors);

  if (!Array.isArray(value.all)) {
    errors.add('conditions.all', 'SCHEMA_INVALID');
    return null;
  }
  if (value.all.length > CAMPAIGN_GROUP_LIMITS.maxAll) {
    errors.add('conditions.all', 'GROUP_SIZE_EXCEEDED', `(en fazla ${CAMPAIGN_GROUP_LIMITS.maxAll})`);
  }

  const context: ConditionContext = {
    trigger,
    facts: new Set(facts ?? []),
    seenTypes: new Set(),
    knownPackageSlugs: options.knownPackageSlugs ?? null,
  };

  const before = errors.list.length;
  const normalised: Array<CampaignCondition | CampaignAnyGroup> = [];

  value.all.forEach((entry, index) => {
    const path = `conditions.all[${index}]`;
    if (!isPlainObject(entry)) {
      errors.add(path, 'SCHEMA_INVALID');
      return;
    }
    if ('any' in entry) {
      const group = validateAnyGroup(entry, path, context, errors);
      if (group) normalised.push(group);
      return;
    }
    if ('all' in entry) {
      errors.add(path, 'GROUP_DEPTH_EXCEEDED');
      return;
    }
    const condition = validateCondition(entry, path, context, errors);
    if (condition) normalised.push(condition);
  });

  return errors.list.length === before ? normalised : null;
}

type ConditionContext = {
  trigger: string | null;
  facts: ReadonlySet<string>;
  seenTypes: Set<string>;
  knownPackageSlugs: ReadonlySet<string> | null;
};

function validateAnyGroup(
  entry: Record<string, unknown>,
  path: string,
  context: ConditionContext,
  errors: Errors,
): CampaignAnyGroup | null {
  rejectUnknownFields(entry, new Set(['any']), path, errors);

  const anyPath = `${path}.any`;
  if (!Array.isArray(entry.any)) {
    errors.add(anyPath, 'SCHEMA_INVALID');
    return null;
  }
  if (entry.any.length === 0) {
    errors.add(anyPath, 'GROUP_EMPTY');
    return null;
  }
  if (entry.any.length > CAMPAIGN_GROUP_LIMITS.maxAny) {
    errors.add(anyPath, 'GROUP_SIZE_EXCEEDED', `(en fazla ${CAMPAIGN_GROUP_LIMITS.maxAny})`);
  }

  const before = errors.list.length;
  const conditions: CampaignCondition[] = [];
  entry.any.forEach((child, index) => {
    const childPath = `${anyPath}[${index}]`;
    if (!isPlainObject(child)) {
      errors.add(childPath, 'SCHEMA_INVALID');
      return;
    }
    if ('any' in child || 'all' in child) {
      errors.add(childPath, 'GROUP_DEPTH_EXCEEDED');
      return;
    }
    const condition = validateCondition(child, childPath, context, errors);
    if (condition) conditions.push(condition);
  });

  return errors.list.length === before ? { any: conditions } : null;
}

function validateCondition(
  entry: Record<string, unknown>,
  path: string,
  context: ConditionContext,
  errors: Errors,
): CampaignCondition | null {
  const type = entry.type;
  const spec: ConditionSpec | undefined =
    typeof type === 'string' ? CAMPAIGN_CONDITIONS[type] : undefined;
  if (typeof type !== 'string' || !spec) {
    errors.add(path, 'UNKNOWN_CONDITION');
    return null;
  }

  if (context.trigger !== null) {
    if (spec.useEligibilityTriggerFor?.includes(context.trigger)) {
      errors.add(path, 'USE_ELIGIBILITY_TRIGGER');
      return null;
    }
    if (!spec.triggers.includes(context.trigger)) {
      errors.add(path, 'CONDITION_TRIGGER_MISMATCH', `(${type} ↔ ${context.trigger})`);
      return null;
    }
  }

  if (context.seenTypes.has(type) || (spec.fact !== undefined && context.facts.has(spec.fact))) {
    errors.add(path, 'DUPLICATE_CONDITION', `(${type})`);
    return null;
  }
  context.seenTypes.add(type);

  const before = errors.list.length;
  const normalised: CampaignCondition = { type };

  for (const key of Object.keys(entry)) {
    if (key !== 'type' && !(key in spec.args)) {
      errors.add(`${path}.${key}`, 'UNKNOWN_ARGUMENT');
    }
  }

  for (const [name, argument] of Object.entries(spec.args)) {
    const argumentPath = `${path}.${name}`;
    const value = validateArgument(entry[name], argument, argumentPath, context, errors);
    if (value !== undefined) {
      normalised[name] = value;
    }
  }

  return errors.list.length === before ? normalised : null;
}

function validateArgument(
  value: unknown,
  spec: ArgumentSpec,
  path: string,
  context: ConditionContext,
  errors: Errors,
): unknown {
  switch (spec.kind) {
    case 'integer':
      if (!isIntegerWithin(value, spec.min, spec.max)) {
        errors.add(path, 'ARGUMENT_INVALID', `(${spec.min}–${spec.max} tam sayı)`);
        return undefined;
      }
      return value;
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        errors.add(path, 'ARGUMENT_INVALID', `(${spec.values.join(', ')})`);
        return undefined;
      }
      return value;
    case 'enumList':
    case 'slugList': {
      if (!Array.isArray(value) || value.length < spec.min || value.length > spec.max) {
        errors.add(path, 'ARGUMENT_INVALID', `(${spec.min}–${spec.max} öğe)`);
        return undefined;
      }
      const before = errors.list.length;
      const seen = new Set<string>();
      const items: string[] = [];
      value.forEach((item, index) => {
        const itemPath = `${path}[${index}]`;
        const accepted =
          typeof item === 'string' &&
          (spec.kind === 'enumList'
            ? spec.values.includes(item)
            : item.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(item));
        if (!accepted) {
          errors.add(itemPath, 'ARGUMENT_INVALID');
          return;
        }
        if (seen.has(item)) {
          errors.add(itemPath, 'ARGUMENT_INVALID', '(tekrar)');
          return;
        }
        seen.add(item);
        if (
          spec.kind === 'slugList' &&
          context.knownPackageSlugs !== null &&
          !context.knownPackageSlugs.has(item)
        ) {
          errors.add(itemPath, 'UNKNOWN_PACKAGE_SLUG');
          return;
        }
        items.push(item);
      });
      return errors.list.length === before ? items : undefined;
    }
  }
}

function validateBenefit(
  value: unknown,
  errors: Errors,
): CampaignDefinition['benefit'] | null {
  if (!isPlainObject(value)) {
    errors.add('benefit', 'BENEFIT_INVALID');
    return null;
  }
  rejectUnknownFields(value, new Set(['type', 'credits', 'expiresInDays']), 'benefit', errors);

  const before = errors.list.length;
  if (typeof value.type !== 'string' || !CAMPAIGN_BENEFIT.types.includes(value.type)) {
    errors.add('benefit.type', 'BENEFIT_INVALID', `(${CAMPAIGN_BENEFIT.types.join(', ')})`);
  }
  if (!isIntegerWithin(value.credits, CAMPAIGN_BENEFIT.credits.min, CAMPAIGN_BENEFIT.credits.max)) {
    errors.add(
      'benefit.credits',
      'BENEFIT_INVALID',
      `(kredi ${CAMPAIGN_BENEFIT.credits.min}–${CAMPAIGN_BENEFIT.credits.max})`,
    );
  }
  if (
    !isIntegerWithin(
      value.expiresInDays,
      CAMPAIGN_BENEFIT.expiresInDays.min,
      CAMPAIGN_BENEFIT.expiresInDays.max,
    )
  ) {
    errors.add(
      'benefit.expiresInDays',
      'BENEFIT_INVALID',
      `(gün ${CAMPAIGN_BENEFIT.expiresInDays.min}–${CAMPAIGN_BENEFIT.expiresInDays.max})`,
    );
  }
  if (errors.list.length !== before) {
    return null;
  }
  return {
    type: value.type as string,
    credits: value.credits as number,
    expiresInDays: value.expiresInDays as number,
  };
}

function validateLimits(
  value: unknown,
  benefitCredits: number | null,
  errors: Errors,
): CampaignDefinition['limits'] | null {
  if (!isPlainObject(value)) {
    errors.add('limits', 'LIMIT_INVALID');
    return null;
  }
  rejectUnknownFields(value, new Set(Object.keys(CAMPAIGN_LIMITS)), 'limits', errors);

  const before = errors.list.length;
  const result: Record<string, number | null> = {};
  for (const [name, bounds] of Object.entries(CAMPAIGN_LIMITS)) {
    const raw = value[name];
    const path = `limits.${name}`;
    if (raw === undefined || raw === null) {
      if (bounds.required) {
        errors.add(path, 'LIMIT_INVALID', '(zorunlu)');
      }
      result[name] = null;
      continue;
    }
    if (!isIntegerWithin(raw, bounds.min, bounds.max)) {
      errors.add(path, 'LIMIT_INVALID', `(${bounds.min}–${bounds.max} tam sayı)`);
      continue;
    }
    result[name] = raw;
  }

  const budget = result.budgetCredits;
  if (typeof budget === 'number' && benefitCredits !== null && budget < benefitCredits) {
    errors.add('limits.budgetCredits', 'LIMIT_INVALID', '(bütçe tek bir lotu bile karşılamıyor)');
  }

  if (errors.list.length !== before) {
    return null;
  }
  return {
    maxRedemptionsPerProvider: result.maxRedemptionsPerProvider as number,
    maxRedemptionsGlobal: result.maxRedemptionsGlobal ?? null,
    maxRedemptionsPerDay: result.maxRedemptionsPerDay ?? null,
    budgetCredits: result.budgetCredits ?? null,
  };
}

function validateWindow(value: unknown, errors: Errors): CampaignDefinition['window'] | null {
  if (value === undefined) {
    return { startAt: null, endAt: null };
  }
  if (!isPlainObject(value)) {
    errors.add('window', 'WINDOW_INVALID');
    return null;
  }
  rejectUnknownFields(value, new Set(['startAt', 'endAt']), 'window', errors);

  const before = errors.list.length;
  const bound = (name: 'startAt' | 'endAt'): string | null | undefined => {
    const raw = value[name];
    if (raw === undefined || raw === null) {
      return null;
    }
    if (typeof raw !== 'string' || !ISO_UTC_INSTANT.test(raw) || Number.isNaN(Date.parse(raw))) {
      errors.add(`window.${name}`, 'WINDOW_INVALID', '(UTC ISO-8601, örn. 2026-10-01T00:00:00Z)');
      return undefined;
    }
    return raw;
  };
  const startAt = bound('startAt');
  const endAt = bound('endAt');

  if (
    typeof startAt === 'string' &&
    typeof endAt === 'string' &&
    Date.parse(startAt) >= Date.parse(endAt)
  ) {
    errors.add('window.endAt', 'WINDOW_INVALID', '(bitiş başlangıçtan sonra olmalı)');
  }

  if (errors.list.length !== before) {
    return null;
  }
  return { startAt: startAt ?? null, endAt: endAt ?? null };
}

/**
 * Every package slug a definition refers to, in order of first appearance,
 * read structurally and tolerantly — the caller uses this to fetch the
 * catalogue before validating, so it must work on input that has not been
 * validated yet.
 */
export function collectPackageSlugs(input: unknown): string[] {
  const slugs: string[] = [];
  const visit = (entry: unknown) => {
    if (!isPlainObject(entry)) return;
    if (Array.isArray(entry.any)) {
      entry.any.forEach(visit);
      return;
    }
    if (entry.type === 'PACKAGE_SLUG_IN' && Array.isArray(entry.slugs)) {
      for (const slug of entry.slugs) {
        if (typeof slug === 'string' && !slugs.includes(slug)) {
          slugs.push(slug);
        }
      }
    }
  };
  if (isPlainObject(input) && isPlainObject(input.conditions) && Array.isArray(input.conditions.all)) {
    input.conditions.all.forEach(visit);
  }
  return slugs;
}
