import type {
  ServiceCategoryKind,
  ServiceCategoryStatus,
  ServiceRequestQuestionSystemField,
  ServiceRequestQuestionType,
} from '@prisma/client';

/**
 * The shape a category wave is written in.
 *
 * These are plain TypeScript literals on purpose. The research this expansion
 * is derived from lives in CSV files, and the importer deliberately does not
 * read them: a runtime CSV parse would put the shape of a scraped spreadsheet —
 * its column order, its encoding, its presence on disk — inside the deployment
 * path of the category catalogue. Converting a wave into this file is a review
 * step somebody performs once, with the result in the diff, in Taktic's own
 * wording.
 */

export type QuestionOptionDefinition = {
  /** Stable, lowercase, never displayed. Renaming one is a data migration. */
  key: string;
  label: string;
};

export type QuestionConditionDefinition = {
  sourceQuestionKey: string;
  expectedValues: string[];
};

export type RouterRuleDefinition = {
  optionKey: string;
  targetCategorySlug: string;
};

export type QuestionDefinition = {
  key: string;
  label: string;
  helpText?: string;
  type: ServiceRequestQuestionType;
  isRequired: boolean;
  sortOrder: number;
  options?: QuestionOptionDefinition[];
  /**
   * Binds the question to a request column instead of an answer row — the
   * address, the budget, the description or the preferred date the request
   * already carries. See question-system-fields.ts in the API.
   */
  systemField?: ServiceRequestQuestionSystemField;
  isRouter?: boolean;
  conditions?: QuestionConditionDefinition[];
  routerRules?: RouterRuleDefinition[];
};

export type CategoryDefinition = {
  slug: string;
  name: string;
  description: string;
  kind: ServiceCategoryKind;
  /**
   * Where the category starts life. A wave lands DRAFT: visible in admin,
   * invisible to customers and to provider discovery, until somebody releases
   * it deliberately.
   *
   * Re-running the import never rewrites this. Status is an operator's
   * decision, and an import that could quietly take a live category off the
   * catalogue — or put an unfinished one on it — is not a safe thing to run.
   */
  status: ServiceCategoryStatus;
  /** Must name a GROUP category, defined earlier in the same wave or already present. */
  parentSlug?: string;
  /**
   * Only meaningful for a LEAF: it is what a provider is charged to offer.
   * Written on create and then left alone, like the rest of the seed treats
   * pricing.
   */
  offerCreditCost?: number;
  sortOrder: number;
  iconKey?: string;
  questions?: QuestionDefinition[];
};

export type CategoryWave = {
  /** Shown in the import's summary line, so a run says which wave it applied. */
  name: string;
  categories: CategoryDefinition[];
};
