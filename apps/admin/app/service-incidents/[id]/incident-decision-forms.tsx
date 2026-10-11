import { ConfirmDialog } from '../../../components/confirm-dialog';
import {
  INCIDENT_DECISION_LABELS,
  RATIONALE_MAX_LENGTH,
  RATIONALE_MIN_LENGTH,
  type IncidentDecision,
} from '../../../lib/service-incidents';

type FormAction = (formData: FormData) => void | Promise<void>;

/** What every decision says before it is made: read from the API's adjudication service. */
function DecisionFacts({ decision }: { decision: IncidentDecision }) {
  return (
    <>
      {decision === 'CONFIRMED' ? (
        <p>
          Bildirim <strong>doğrulanır</strong> ve hizmet verenin son 90 gündeki doğrulanmış aksaklık sayısına eklenir.
          Sayı 2&apos;ye ulaşırsa seviye “Uyarı”, 3&apos;e ulaşırsa “Yönetici incelemesi gerekli” olur ve bir inceleme
          açılır.
        </p>
      ) : (
        <p>
          Bildirim <strong>reddedilir</strong> ve hizmet verenin doğrulanmış aksaklık sayısına eklenmez.
        </p>
      )}
      <p>
        <strong>Otomatik kredi iadesi yok.</strong> Hizmet verenin bu talepten kalıcı dışlanması ve talebin yeni turu
        değişmez.
      </p>
      <p>
        Gerekçeniz adınızla kaydedilir ve hizmet verene ya da müşteriye gösterilmez. Hizmet veren yalnız kararın
        sonucunu görür.
      </p>
    </>
  );
}

/**
 * Doğrula / Reddet on an undecided incident (SERVICE_INCIDENTS_ADJUDICATE —
 * the page renders this only for a session that holds it). One form, one
 * mandatory rationale, two confirmations: the pressed trigger carries the
 * decision as its name/value.
 *
 * The provider's 72-hour window is never a lock: when it is still open the
 * page says so above this form and the buttons stay usable.
 */
export function IncidentAdjudicateForm({ incidentId, action }: { incidentId: string; action: FormAction }) {
  return (
    <form action={action} className="refund-action detail-form" data-testid="incident-adjudicate-form">
      <input type="hidden" name="incidentId" value={incidentId} />
      <p className="refund-action-title">Karar ver</p>
      <label className="detail-form-field" htmlFor="incident-rationale">
        <span>
          Gerekçe ({RATIONALE_MIN_LENGTH}–{RATIONALE_MAX_LENGTH} karakter, zorunlu; yalnız iç kayıt)
        </span>
        <textarea
          id="incident-rationale"
          name="rationale"
          rows={4}
          required
          minLength={RATIONALE_MIN_LENGTH}
          maxLength={RATIONALE_MAX_LENGTH}
          data-testid="incident-rationale"
        />
      </label>
      <div className="detail-form-actions">
        <ConfirmDialog
          proof="service-incident.adjudicate"
          triggerLabel="Doğrula"
          triggerClassName="btn btn-destructive btn-sm"
          name="decision"
          value="CONFIRMED"
          title="Bildirim doğrulansın mı?"
          consequence={<DecisionFacts decision="CONFIRMED" />}
          confirmLabel="Evet, doğrula"
          testId="incident-confirm"
          confirmTestId="incident-decision-submit"
        />
        <ConfirmDialog
          proof="service-incident.adjudicate"
          triggerLabel="Reddet"
          triggerClassName="btn btn-secondary btn-sm"
          tone="primary"
          name="decision"
          value="DISMISSED"
          title="Bildirim reddedilsin mi?"
          consequence={<DecisionFacts decision="DISMISSED" />}
          confirmLabel="Evet, reddet"
          testId="incident-dismiss"
          confirmTestId="incident-decision-submit"
        />
      </div>
    </form>
  );
}

/**
 * Kararı düzelt (SERVICE_INCIDENTS_CORRECT — reserved for a super admin). The
 * new decision is the other one; the form carries the head the operator was
 * looking at, and the API answers 409 INCIDENT_ADJUDICATION_CHANGED if the
 * chain moved since. The earlier decisions stay in the timeline.
 */
export function IncidentCorrectForm({
  incidentId,
  current,
  effectiveAdjudicationId,
  action,
}: {
  incidentId: string;
  current: IncidentDecision;
  effectiveAdjudicationId: string;
  action: FormAction;
}) {
  const next: IncidentDecision = current === 'CONFIRMED' ? 'DISMISSED' : 'CONFIRMED';
  return (
    <form action={action} className="refund-action detail-form" data-testid="incident-correct-form">
      <input type="hidden" name="incidentId" value={incidentId} />
      <input type="hidden" name="decision" value={next} />
      <input type="hidden" name="expectedEffectiveAdjudicationId" value={effectiveAdjudicationId} />
      <p className="refund-action-title">Kararı düzelt (yalnız süper yönetici)</p>
      <p className="detail-muted-note">
        Geçerli karar: <strong>{INCIDENT_DECISION_LABELS[current]}</strong> → yeni karar:{' '}
        <strong data-testid="incident-correct-next">{INCIDENT_DECISION_LABELS[next]}</strong>
      </p>
      <label className="detail-form-field" htmlFor="incident-rationale">
        <span>
          Düzeltme gerekçesi ({RATIONALE_MIN_LENGTH}–{RATIONALE_MAX_LENGTH} karakter, zorunlu)
        </span>
        <textarea
          id="incident-rationale"
          name="rationale"
          rows={4}
          required
          minLength={RATIONALE_MIN_LENGTH}
          maxLength={RATIONALE_MAX_LENGTH}
          data-testid="incident-rationale"
        />
      </label>
      <div className="detail-form-actions">
        <ConfirmDialog
          proof="service-incident.correct"
          triggerLabel="Kararı düzelt"
          triggerClassName="btn btn-destructive btn-sm"
          title={`Karar “${INCIDENT_DECISION_LABELS[next]}” olarak düzeltilsin mi?`}
          consequence={
            <>
              <p>
                Yeni bir düzeltme kaydı eklenir ve geçerli karar olur. Önceki karar ve gerekçesi silinmez; zaman
                çizelgesinde kalır.
              </p>
              <DecisionFacts decision={next} />
              <p>Bu sayfa açıldıktan sonra karar değiştiyse düzeltme reddedilir ve hiçbir şey yazılmaz.</p>
            </>
          }
          confirmLabel="Evet, düzelt"
          testId="incident-correct"
          confirmTestId="incident-decision-submit"
        />
      </div>
    </form>
  );
}
