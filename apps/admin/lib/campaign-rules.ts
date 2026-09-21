import catalog from '../../../packages/shared/campaign-rules.json';

/**
 * The admin panel's share of the campaign rule language (CMP-002 S0/S1).
 *
 * Read from the same `campaign-rules.json` the API validator reads, so the
 * builder can only offer what the validator accepts — and deliberately
 * nothing more than a projection of it. This file turns a form into a
 * definition and a validator error path back into a form field; it does not
 * judge a definition. An operator who types "on" into the credits field gets
 * a definition with `credits: "on"`, the API refuses it with
 * `BENEFIT_INVALID @ benefit.credits`, and this file points that at the
 * credits input. One authority, one set of sentences.
 *
 * Client-safe: no `next/headers`, no fetch. The form component imports it.
 */

export type CampaignTrigger = (typeof catalog.triggers)[number];
export type CampaignFact = (typeof catalog.facts)[number];
export type CampaignConditionType = keyof typeof catalog.conditions;
export type ConditionGroup = 'all' | 'any';

type ArgumentSpec =
  | { kind: 'integer'; min: number; max: number }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'enumList'; values: readonly string[]; min: number; max: number }
  | { kind: 'slugList'; min: number; max: number };

type ConditionSpec = {
  triggers: readonly string[];
  useEligibilityTriggerFor?: readonly string[];
  fact?: string;
  args: Readonly<Record<string, ArgumentSpec>>;
};

const CONDITIONS = catalog.conditions as Readonly<Record<string, ConditionSpec>>;

export const CAMPAIGN_RULES_CATALOG = catalog;

// ───────────────────────────────── labels ─────────────────────────────────

export const TRIGGER_LABELS: Record<CampaignTrigger, string> = {
  PROVIDER_APPROVED: 'Hizmet veren onaylandı',
  PACKAGE_PAYMENT_SUCCEEDED: 'Paket ödemesi tamamlandı',
  PROVIDER_ELIGIBILITY_REACHED: 'Uygunluk geçişi (olgu kümesi ilk kez tamamlandı)',
};

export const TRIGGER_HELP: Record<CampaignTrigger, string> = {
  PROVIDER_APPROVED: 'Profil ilk kez APPROVED durumuna geçtiği anda değerlendirilir.',
  PACKAGE_PAYMENT_SUCCEEDED: 'Doğrulanmış ödeme webhook’u satın almayı PAID yazdığı anda değerlendirilir.',
  PROVIDER_ELIGIBILITY_REACHED:
    'Seçilen olguların tamamı bir hizmet veren için ilk kez birlikte doğru olduğunda, sıradan bağımsız, bir kez değerlendirilir.',
};

export const CAMPAIGN_TRIGGER_OPTIONS: Array<{ value: CampaignTrigger; label: string; help: string }> =
  catalog.triggers.map((value) => ({
    value,
    label: TRIGGER_LABELS[value] ?? value,
    help: TRIGGER_HELP[value] ?? '',
  }));

export const FACT_LABELS: Record<CampaignFact, string> = {
  PROVIDER_APPROVED: 'Profil onaylı',
  EMAIL_VERIFIED: 'E-posta doğrulanmış',
  PHONE_VERIFIED: 'Telefon doğrulanmış',
};

export const CONDITION_LABELS: Record<CampaignConditionType, string> = {
  FIRST_PROVIDER_APPROVAL: 'İlk onay (daha önce onay hak edişi yok)',
  EMAIL_VERIFIED: 'E-posta doğrulanmış (o anda)',
  PHONE_VERIFIED: 'Telefon doğrulanmış (o anda)',
  FIRST_SUCCESSFUL_PAID_PURCHASE: 'İlk başarılı ücretli satın alma',
  PACKAGE_SLUG_IN: 'Paket slug’ı şunlardan biri',
  PACKAGE_TYPE_IN: 'Paket türü şunlardan biri',
  PURCHASE_KIND_IN: 'Satın alma türü',
  MIN_PAID_AMOUNT: 'En az ödenen tutar',
  NO_PRIOR_REVOCATION: 'Daha önce geri alınmış hak ediş yok',
  PROVIDER_APPROVED_WITHIN_DAYS: 'Onay şu kadar gün içinde',
};

export const ARGUMENT_LABELS: Record<string, string> = {
  slugs: 'Paket slug’ları (virgülle)',
  types: 'Paket türleri',
  kinds: 'Satın alma türleri',
  minor: 'Tutar (kuruş)',
  currency: 'Para birimi',
  days: 'Gün',
};

export const ENUM_VALUE_LABELS: Record<string, string> = {
  ONE_TIME_CREDITS: 'Tek seferlik kredi',
  MONTHLY_QUOTA: 'Aylık kota',
  CATEGORY_UNLIMITED: 'Kategori limitsiz',
  OFFER_PACKAGE: 'Teklif paketi',
  TRY: 'TRY',
};

export const STACK_POLICY_LABEL = 'Özel kredi bonusu — bir olay en fazla bir kampanyadan kredi üretir';

const RULE_ERROR_FALLBACKS: Record<string, string> = {
  SCHEMA_INVALID: 'Tanım beklenen yapıda değil.',
  UNSUPPORTED_SCHEMA_VERSION: 'Desteklenmeyen şema sürümü.',
  UNKNOWN_FIELD: 'Tanımda yer alamayacak bir alan var.',
  UNKNOWN_TRIGGER: 'Tetikleyici katalogda yok.',
  UNKNOWN_CONDITION: 'Koşul türü katalogda yok.',
  CONDITION_TRIGGER_MISMATCH: 'Bu koşul seçilen tetikleyiciyle kullanılamaz.',
  USE_ELIGIBILITY_TRIGGER: 'Kanıt koşulu onay olayında kullanılamaz; uygunluk geçişi tetikleyicisini seçin.',
  ELIGIBILITY_REQUIRED: 'Uygunluk geçişi için olgu kümesi seçin.',
  ELIGIBILITY_NOT_ALLOWED: 'Olgu kümesi yalnız uygunluk geçişinde tanımlanır.',
  UNKNOWN_FACT: 'Olgu katalogda yok.',
  DUPLICATE_FACT: 'Aynı olgu iki kez seçilmiş.',
  FACT_SET_SIZE: 'Olgu kümesi boyutu izin verilen aralığın dışında.',
  GROUP_DEPTH_EXCEEDED: 'Koşul grupları fazla iç içe.',
  GROUP_SIZE_EXCEEDED: 'Grupta izin verilenden fazla koşul var.',
  GROUP_EMPTY: 'Alternatif grubu boş olamaz.',
  ARGUMENT_INVALID: 'Koşul değeri geçersiz.',
  UNKNOWN_ARGUMENT: 'Bu koşul böyle bir değer almaz.',
  UNKNOWN_PACKAGE_SLUG: 'Paket slug’ı katalogda yok.',
  DUPLICATE_CONDITION: 'Aynı koşul türü bir kez kullanılabilir.',
  BENEFIT_INVALID: 'Fayda geçersiz.',
  LIMIT_INVALID: 'Limit geçersiz.',
  WINDOW_INVALID: 'Zaman penceresi geçersiz.',
  STACK_POLICY_INVALID: 'Desteklenmeyen stack politikası.',
  PRIORITY_INVALID: 'Öncelik 1–1000 arası tam sayı olmalı.',
  // Activation-only refusals (CMP-002 S2B2); the API's own sentence is preferred.
  FACT_SOURCE_UNAVAILABLE: 'Bu olgunun hizmet veren yazıcısı kayıtlı değil; sürüm etkinleştirilemez.',
  LIMIT_BELOW_CONSUMED: 'Limit, kampanyanın zaten tükettiği değerin altında.',
};

/** The API's sentence when it sent one; the catalogue fallback otherwise. */
export function ruleErrorMessage(code: string, apiMessage: string | undefined): string {
  return apiMessage?.trim() || RULE_ERROR_FALLBACKS[code] || code;
}

// ───────────────────────────────── options ─────────────────────────────────

export type ConditionOption = {
  value: CampaignConditionType;
  label: string;
  args: Readonly<Record<string, ArgumentSpec>>;
};

/** Conditions the catalogue allows on a trigger, in catalogue order. */
export function conditionOptionsFor(trigger: string): ConditionOption[] {
  return (Object.keys(CONDITIONS) as CampaignConditionType[])
    .filter((type) => {
      const spec = CONDITIONS[type]!;
      return spec.triggers.includes(trigger) && !spec.useEligibilityTriggerFor?.includes(trigger);
    })
    .map((type) => ({ value: type, label: CONDITION_LABELS[type], args: CONDITIONS[type]!.args }));
}

export function argumentSpecsOf(type: string): Readonly<Record<string, ArgumentSpec>> {
  return CONDITIONS[type]?.args ?? {};
}

export function isEligibilityTrigger(trigger: string): boolean {
  return trigger === catalog.eligibilityTrigger;
}

// ────────────────────────────────── form ──────────────────────────────────

/** One condition row as the operator sees it: strings and string lists, untyped. */
export type ConditionRow = {
  id: string;
  type: CampaignConditionType | '';
  group: ConditionGroup;
  args: Record<string, string | string[]>;
};

export type CampaignForm = {
  trigger: CampaignTrigger;
  facts: CampaignFact[];
  conditions: ConditionRow[];
  credits: string;
  expiresInDays: string;
  maxRedemptionsPerProvider: string;
  maxRedemptionsGlobal: string;
  maxRedemptionsPerDay: string;
  budgetCredits: string;
  /** `datetime-local` values, read as UTC wall time — the inputs are labelled "(UTC)". */
  windowStartAt: string;
  windowEndAt: string;
  priority: string;
};

export function emptyForm(): CampaignForm {
  return {
    trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
    facts: [],
    conditions: [],
    credits: '',
    expiresInDays: '30',
    maxRedemptionsPerProvider: '1',
    maxRedemptionsGlobal: '',
    maxRedemptionsPerDay: '',
    budgetCredits: '',
    windowStartAt: '',
    windowEndAt: '',
    priority: String(catalog.priority.default),
  };
}

let rowSequence = 0;
export function newConditionRow(type: CampaignConditionType | '' = ''): ConditionRow {
  rowSequence += 1;
  return { id: `c${rowSequence}-${Date.now().toString(36)}`, type, group: 'all', args: {} };
}

/**
 * A number as typed, or what the API should see instead: `null` for an empty
 * field (an optional limit left blank), the raw string for anything that is
 * not a whole number (so the API names the field), never a coerced value.
 */
function numberOrRaw(value: string): number | string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

/** `datetime-local` (`YYYY-MM-DDTHH:mm`) → UTC instant string, or the raw value. */
function instantOrRaw(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed) ? `${trimmed}:00Z` : trimmed;
}

function listArgument(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function conditionArguments(row: ConditionRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(argumentSpecsOf(row.type))) {
    const raw = row.args[name];
    switch (spec.kind) {
      case 'integer':
        out[name] = numberOrRaw(typeof raw === 'string' ? raw : '');
        break;
      case 'enum':
        out[name] = typeof raw === 'string' && raw !== '' ? raw : spec.values.length === 1 ? spec.values[0] : raw ?? null;
        break;
      case 'enumList':
      case 'slugList':
        out[name] = listArgument(raw);
        break;
    }
  }
  return out;
}

export type CampaignDefinitionDraft = {
  schemaVersion: 1;
  trigger: string;
  eligibility?: { facts: string[] };
  conditions: { all: unknown[] };
  benefit: { type: string; credits: unknown; expiresInDays: unknown };
  limits: Record<string, unknown>;
  window: { startAt: unknown; endAt: unknown };
  stackPolicy: string;
  priority: unknown;
};

/**
 * The form as a definition: root `all` in row order, with every row marked
 * "alternatif" collected into one `any` group placed where the first such
 * row was.
 */
export function buildDefinition(form: CampaignForm): CampaignDefinitionDraft {
  const all: unknown[] = [];
  const any: unknown[] = [];
  let anyIndex = -1;
  for (const row of form.conditions) {
    const condition = { type: row.type, ...conditionArguments(row) };
    if (row.group === 'any') {
      if (anyIndex === -1) {
        anyIndex = all.length;
        all.push(null);
      }
      any.push(condition);
    } else {
      all.push(condition);
    }
  }
  if (anyIndex !== -1) {
    all[anyIndex] = { any };
  }

  return {
    schemaVersion: 1,
    trigger: form.trigger,
    ...(isEligibilityTrigger(form.trigger) ? { eligibility: { facts: form.facts } } : {}),
    conditions: { all },
    benefit: {
      type: catalog.benefit.types[0]!,
      credits: numberOrRaw(form.credits),
      expiresInDays: numberOrRaw(form.expiresInDays),
    },
    limits: {
      maxRedemptionsPerProvider: numberOrRaw(form.maxRedemptionsPerProvider),
      maxRedemptionsGlobal: numberOrRaw(form.maxRedemptionsGlobal),
      maxRedemptionsPerDay: numberOrRaw(form.maxRedemptionsPerDay),
      budgetCredits: numberOrRaw(form.budgetCredits),
    },
    window: { startAt: instantOrRaw(form.windowStartAt), endAt: instantOrRaw(form.windowEndAt) },
    stackPolicy: catalog.stackPolicies[0]!,
    priority: numberOrRaw(form.priority),
  };
}

function stringOf(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function instantToLocalInput(value: unknown): string {
  if (typeof value !== 'string') return '';
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/.exec(value);
  return match ? match[1]! : value;
}

function rowFromCondition(entry: unknown, group: ConditionGroup): ConditionRow {
  const record = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
  const type = typeof record.type === 'string' && record.type in CONDITIONS ? (record.type as CampaignConditionType) : '';
  const row = newConditionRow(type);
  row.group = group;
  for (const [name, spec] of Object.entries(argumentSpecsOf(type))) {
    const raw = record[name];
    if (spec.kind === 'slugList') {
      row.args[name] = Array.isArray(raw) ? raw.map(String).join(', ') : stringOf(raw);
    } else if (spec.kind === 'enumList') {
      row.args[name] = Array.isArray(raw) ? raw.map(String) : [];
    } else {
      row.args[name] = stringOf(raw);
    }
  }
  return row;
}

/** A stored definition back into the form, for "new revision" pre-fill. */
export function formFromDefinition(definition: unknown): CampaignForm {
  const form = emptyForm();
  const record = typeof definition === 'object' && definition !== null ? (definition as Record<string, unknown>) : {};

  if (typeof record.trigger === 'string' && (catalog.triggers as readonly string[]).includes(record.trigger)) {
    form.trigger = record.trigger as CampaignTrigger;
  }
  const eligibility = record.eligibility as { facts?: unknown } | undefined;
  if (Array.isArray(eligibility?.facts)) {
    form.facts = eligibility.facts.filter((fact): fact is CampaignFact => (catalog.facts as readonly string[]).includes(String(fact)));
  }
  const conditions = record.conditions as { all?: unknown } | undefined;
  if (Array.isArray(conditions?.all)) {
    for (const entry of conditions.all) {
      const group = entry as { any?: unknown };
      if (Array.isArray(group?.any)) {
        for (const child of group.any) form.conditions.push(rowFromCondition(child, 'any'));
      } else {
        form.conditions.push(rowFromCondition(entry, 'all'));
      }
    }
  }
  const benefit = (record.benefit ?? {}) as Record<string, unknown>;
  form.credits = stringOf(benefit.credits);
  form.expiresInDays = stringOf(benefit.expiresInDays);
  const limits = (record.limits ?? {}) as Record<string, unknown>;
  form.maxRedemptionsPerProvider = stringOf(limits.maxRedemptionsPerProvider);
  form.maxRedemptionsGlobal = stringOf(limits.maxRedemptionsGlobal);
  form.maxRedemptionsPerDay = stringOf(limits.maxRedemptionsPerDay);
  form.budgetCredits = stringOf(limits.budgetCredits);
  const window = (record.window ?? {}) as Record<string, unknown>;
  form.windowStartAt = instantToLocalInput(window.startAt);
  form.windowEndAt = instantToLocalInput(window.endAt);
  form.priority = stringOf(record.priority);
  return form;
}

// ─────────────────────────────── error → field ───────────────────────────────

export type ErrorTarget =
  | { field: 'form' }
  | { field: 'trigger' | 'facts' | 'conditions' | 'credits' | 'expiresInDays' | 'priority' }
  | { field: 'maxRedemptionsPerProvider' | 'maxRedemptionsGlobal' | 'maxRedemptionsPerDay' | 'budgetCredits' }
  | { field: 'windowStartAt' | 'windowEndAt' }
  | { field: 'condition'; conditionId: string; argument: string | null };

/**
 * Where a validator error lands on the form. Condition paths are resolved
 * through the same layout `buildDefinition` produced — root index, then the
 * index inside the single `any` group — back to the row's id.
 */
export function errorFieldOf(path: string, form: CampaignForm): ErrorTarget {
  if (path === 'trigger') return { field: 'trigger' };
  if (path.startsWith('eligibility')) return { field: 'facts' };
  if (path === 'benefit.credits') return { field: 'credits' };
  if (path === 'benefit.expiresInDays') return { field: 'expiresInDays' };
  if (path === 'priority') return { field: 'priority' };
  const limit = /^limits\.(maxRedemptionsPerProvider|maxRedemptionsGlobal|maxRedemptionsPerDay|budgetCredits)$/.exec(path);
  if (limit) return { field: limit[1] as 'maxRedemptionsPerProvider' };
  if (path === 'window.startAt') return { field: 'windowStartAt' };
  if (path === 'window.endAt') return { field: 'windowEndAt' };

  const condition = /^conditions\.all\[(\d+)\](?:\.any\[(\d+)\])?(?:\.([A-Za-z]+))?/.exec(path);
  if (condition) {
    const rootIndex = Number(condition[1]);
    const anyIndex = condition[2] === undefined ? null : Number(condition[2]);
    const argument = condition[3] ?? null;
    const row = rowAt(form, rootIndex, anyIndex);
    if (row && (argument === null || argument !== 'any')) {
      return { field: 'condition', conditionId: row.id, argument };
    }
    return { field: 'conditions' };
  }
  if (path.startsWith('conditions')) return { field: 'conditions' };
  return { field: 'form' };
}

function rowAt(form: CampaignForm, rootIndex: number, anyIndex: number | null): ConditionRow | null {
  const anyRows = form.conditions.filter((row) => row.group === 'any');
  const layout: Array<ConditionRow | 'any'> = [];
  let anyPlaced = false;
  for (const row of form.conditions) {
    if (row.group === 'any') {
      if (!anyPlaced) {
        layout.push('any');
        anyPlaced = true;
      }
    } else {
      layout.push(row);
    }
  }
  const entry = layout[rootIndex];
  if (entry === undefined) return null;
  if (entry === 'any') {
    return anyIndex === null ? null : (anyRows[anyIndex] ?? null);
  }
  return anyIndex === null ? entry : null;
}
