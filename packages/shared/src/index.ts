export const TAKTIC_APP_NAME = 'TakTic';

export { SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH } from './service-requests';

export { detectContactDetails } from './contact-detection';
export type { ContactDetailKind, ContactDetection } from './contact-detection';

export {
  SUPPORT_TICKET_MESSAGE_MAX_LENGTH,
  SUPPORT_TICKET_SUBJECT_MAX_LENGTH,
} from './support-tickets';

export {
  DEFAULT_SAFE_REDIRECT,
  safeRedirectPath,
  safeRedirectPathOrNull,
} from './safe-redirect';

export { URGENCY_LABELS, isUrgencyCode, urgencyLabel } from './urgency';

export { UNVERIFIED_LABEL, VERIFIED_LABEL, contactVerification } from './contact-verification';
export type { ContactVerification } from './contact-verification';
export type { UrgencyCode } from './urgency';

export {
  TAKTIC_LOCALE,
  TAKTIC_TIME_ZONE,
  formatDate,
  formatDateTime,
  addIsoDays,
  compareIsoDays,
  endOfWeekIsoDay,
  formatDateRange,
  formatIsoDay,
  formatTime,
  isIsoDay,
  isoDayRangeBounds,
  isoDayStart,
  orderIsoDayRange,
  todayIsoDay,
} from './datetime';
export type { DateInput, IsoDay } from './datetime';

export {
  serviceAreaCovers,
  serviceAreaLabel,
  serviceAreaRejectionReason,
  serviceAreaScope,
} from './provider-service-areas';
export type { ServiceAreaLike, ServiceAreaScope } from './provider-service-areas';

export {
  formatMinorAsTurkishLira,
  formatMinorAsTurkishLiraInput,
  parseTurkishLiraToMinor,
} from './money';

export { formPostRoute, isSameOriginFormPost } from './form-post';

export {
  OFFER_SCHEDULE_ERROR_CODES,
  OFFER_SCHEDULE_ERROR_MESSAGES,
  OFFER_SCHEDULE_MAX_DAYS,
  isOfferScheduleErrorCode,
  offerScheduleBounds,
  validateOfferSchedule,
} from './offer-schedule';
export type { OfferScheduleErrorCode } from './offer-schedule';

export {
  CATEGORY_DELIVERY_MODELS,
  CATEGORY_DELIVERY_MODEL_HINTS,
  CATEGORY_DELIVERY_MODEL_LABELS,
  REQUEST_DELIVERY_MODE_LABELS,
  fixedDeliveryMode,
  isCategoryDeliveryModel,
  isRequestDeliveryMode,
  requestDeliveryMode,
} from './delivery-model';
export type { CategoryDeliveryModel, RequestDeliveryMode } from './delivery-model';

export { countMeaningfulWords, scoreRequestQuality } from './quality-score';
export type {
  QualityComponent,
  QualityComponentKey,
  QualityLabel,
  QualityTip,
  RequestQualityResult,
  RequestQualitySignals,
} from './quality-score';

export {
  CREDENTIAL_REFUSAL_MESSAGES,
  TURNSTILE_ACTIONS,
  TURNSTILE_CHALLENGE_FAILED,
  TURNSTILE_FORM_FIELD,
  TURNSTILE_TOKEN_HEADER,
  credentialRefusalOf,
  isCredentialRefusal,
  isTurnstileRefusalCode,
  readTurnstileFormToken,
  readTurnstileWebConfig,
  resolveTestTurnstileToken,
  turnstileHeaders,
} from './turnstile-web';
export type {
  CredentialRefusal,
  TurnstileAction,
  TurnstileTestOverride,
  TurnstileWebConfig,
} from './turnstile-web';
