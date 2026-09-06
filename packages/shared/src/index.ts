export const TAKTIC_APP_NAME = 'TakTic';

export { SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH } from './service-requests';

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
export type { UrgencyCode } from './urgency';

export {
  TAKTIC_LOCALE,
  TAKTIC_TIME_ZONE,
  formatDate,
  formatDateTime,
  formatIsoDay,
  formatTime,
} from './datetime';
export type { DateInput } from './datetime';

export {
  serviceAreaCovers,
  serviceAreaLabel,
  serviceAreaRejectionReason,
  serviceAreaScope,
} from './provider-service-areas';
export type { ServiceAreaLike, ServiceAreaScope } from './provider-service-areas';
