import { CAMPAIGN_ACTIVATION_ERROR_CODE_LIST, CAMPAIGN_RULE_ERROR_CODE_LIST } from './catalog';

/**
 * The closed set of reasons a campaign definition is refused.
 *
 * Closed on purpose: the admin panel maps every code to a sentence beside the
 * field it names, and a code this list does not carry would surface there as
 * a raw identifier. The list itself lives in the shared catalogue so both
 * sides agree on it; the sentences are here, because they are written for the
 * operator reading the API's answer and nowhere else.
 */
export type CampaignRuleErrorCode =
  | 'SCHEMA_INVALID'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'UNKNOWN_FIELD'
  | 'UNKNOWN_TRIGGER'
  | 'UNKNOWN_CONDITION'
  | 'CONDITION_TRIGGER_MISMATCH'
  | 'USE_ELIGIBILITY_TRIGGER'
  | 'ELIGIBILITY_REQUIRED'
  | 'ELIGIBILITY_NOT_ALLOWED'
  | 'UNKNOWN_FACT'
  | 'DUPLICATE_FACT'
  | 'FACT_SET_SIZE'
  | 'GROUP_DEPTH_EXCEEDED'
  | 'GROUP_SIZE_EXCEEDED'
  | 'GROUP_EMPTY'
  | 'ARGUMENT_INVALID'
  | 'UNKNOWN_ARGUMENT'
  | 'UNKNOWN_PACKAGE_SLUG'
  | 'DUPLICATE_CONDITION'
  | 'BENEFIT_INVALID'
  | 'LIMIT_INVALID'
  | 'WINDOW_INVALID'
  | 'STACK_POLICY_INVALID'
  | 'PRIORITY_INVALID'
  | 'CHANNEL_INVALID';

export const CAMPAIGN_RULE_ERROR_CODES =
  CAMPAIGN_RULE_ERROR_CODE_LIST as readonly CampaignRuleErrorCode[];

/**
 * The refusals that exist only at activation (CMP-002 S2B2, CMP-006 PR-D). A
 * stored version is a valid definition by construction; what activation adds
 * is the state of the world — which writers are booted, which channels they
 * can stamp on an event, what the campaign already consumed — and these name
 * the ways that state can say no.
 */
export type CampaignActivationErrorCode =
  | 'FACT_SOURCE_UNAVAILABLE'
  | 'LIMIT_BELOW_CONSUMED'
  | 'CHANNEL_SOURCE_UNAVAILABLE';

export const CAMPAIGN_ACTIVATION_ERROR_CODES =
  CAMPAIGN_ACTIVATION_ERROR_CODE_LIST as readonly CampaignActivationErrorCode[];

export type CampaignRuleError = {
  /** JSON-pointer-like path into the definition: `conditions.all[2].slugs[1]`. Empty for the root. */
  path: string;
  code: CampaignRuleErrorCode;
  message: string;
};

/** An activation refusal: a definition error, or one of the activation-only codes, same shape. */
export type CampaignActivationError = {
  path: string;
  code: CampaignRuleErrorCode | CampaignActivationErrorCode;
  message: string;
};

/**
 * Default sentence per code. Callers may append the detail that makes a
 * sentence specific (which trigger, which bound) — never the operator's raw
 * input, so a message cannot echo something that was not a rule.
 */
export const CAMPAIGN_RULE_ERROR_MESSAGES: Readonly<Record<CampaignRuleErrorCode, string>> = {
  SCHEMA_INVALID: 'Kampanya tanımı beklenen yapıda değil.',
  UNSUPPORTED_SCHEMA_VERSION: 'Yalnızca schemaVersion 1 desteklenir.',
  UNKNOWN_FIELD: 'Bu alan kampanya tanımında yer alamaz.',
  UNKNOWN_TRIGGER: 'Tetikleyici katalogda yok.',
  UNKNOWN_CONDITION: 'Koşul türü katalogda yok.',
  CONDITION_TRIGGER_MISMATCH: 'Bu koşul seçilen tetikleyiciyle kullanılamaz.',
  USE_ELIGIBILITY_TRIGGER:
    'E-posta/telefon kanıtı onay olayında koşul olamaz; bileşik şart için uygunluk geçişi tetikleyicisini kullanın.',
  ELIGIBILITY_REQUIRED: 'Uygunluk geçişi tetikleyicisi olgu kümesi ister.',
  ELIGIBILITY_NOT_ALLOWED: 'Olgu kümesi yalnızca uygunluk geçişi tetikleyicisinde tanımlanır.',
  UNKNOWN_FACT: 'Olgu katalogda yok.',
  DUPLICATE_FACT: 'Aynı olgu kümede iki kez yer alamaz.',
  FACT_SET_SIZE: 'Olgu kümesi boyutu izin verilen aralığın dışında.',
  GROUP_DEPTH_EXCEEDED: 'Koşul grupları en fazla bir seviye iç içe olabilir (kök "all", içinde "any").',
  GROUP_SIZE_EXCEEDED: 'Grup izin verilenden fazla koşul içeriyor.',
  GROUP_EMPTY: 'Alternatif grubu ("any") boş olamaz.',
  ARGUMENT_INVALID: 'Koşul argümanı geçersiz.',
  UNKNOWN_ARGUMENT: 'Bu koşul böyle bir argüman almaz.',
  UNKNOWN_PACKAGE_SLUG: 'Paket slug’ı katalogda yok.',
  DUPLICATE_CONDITION: 'Aynı koşul türü tanımda bir kez yer alabilir.',
  BENEFIT_INVALID: 'Fayda geçersiz: yalnızca sınırlı, pozitif promosyon kredisi tanımlanabilir.',
  LIMIT_INVALID: 'Limit geçersiz.',
  WINDOW_INVALID: 'Zaman penceresi geçersiz.',
  STACK_POLICY_INVALID: 'Yalnızca EXCLUSIVE_CREDIT_BONUS politikası desteklenir.',
  PRIORITY_INVALID: 'Öncelik 1–1000 arası tam sayı olmalıdır.',
  CHANNEL_INVALID: 'Kanal yalnızca WEB, MOBILE veya ALL olabilir.',
};

export const CAMPAIGN_ACTIVATION_ERROR_MESSAGES: Readonly<Record<CampaignActivationErrorCode, string>> = {
  FACT_SOURCE_UNAVAILABLE:
    'Bu olgunun/tetikleyicinin hizmet veren hesapları için kayıtlı bir yazıcısı yok; sürüm etkinleştirilemez.',
  LIMIT_BELOW_CONSUMED: 'Limit, kampanyanın halihazırda tükettiği değerin altında; önce daha yüksek bir limitle sürüm oluşturun.',
  CHANNEL_SOURCE_UNAVAILABLE:
    'Bu kanaldan olay üreten kayıtlı bir kaynak yok; bu kanalı hedefleyen sürüm hiçbir hak ediş üretemeyeceği için etkinleştirilemez.',
};
