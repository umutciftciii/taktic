import {
  isOfferScheduleErrorCode,
  OFFER_SCHEDULE_ERROR_MESSAGES,
  offerScheduleBounds,
} from '@taktic/shared';

/**
 * The two schedule fields of an offer — when the work starts and when it is
 * done — for both places a provider prices a job: the marketplace request and
 * the vitrin lead (REL-002 §6.1).
 *
 * Both are required. The browser is told the same window the API enforces —
 * from today (Europe/Istanbul) to the shared horizon — through `min`/`max`, so
 * the date picker offers nothing the server would refuse. The server action
 * checks again with the shared `validateOfferSchedule`, and the API checks a
 * third time on its own clock: these attributes are a convenience, not the
 * rule.
 */
export function OfferScheduleFields() {
  const { min, max } = offerScheduleBounds();

  return (
    <>
      <label className="pdash-form-row">
        <span>Tahmini başlangıç *</span>
        <input name="estimatedStartDate" type="date" required min={min} max={max} />
      </label>
      <label className="pdash-form-row">
        <span>Tahmini bitiş *</span>
        <input name="estimatedCompletionDate" type="date" required min={min} max={max} />
      </label>
    </>
  );
}

/**
 * The refusal a schedule error code names, as a notice — `null` for any other
 * value, so a screen can pass its error query parameter straight through.
 */
export function OfferScheduleNotice({ code }: { code: string | undefined }) {
  if (!isOfferScheduleErrorCode(code)) return null;

  return (
    <div className="pdash-notice pdash-notice-error" role="alert" data-testid="offer-schedule-error">
      <span>
        <strong>Teklif gönderilmedi, kredi düşülmedi.</strong> {OFFER_SCHEDULE_ERROR_MESSAGES[code]}
      </span>
    </div>
  );
}
