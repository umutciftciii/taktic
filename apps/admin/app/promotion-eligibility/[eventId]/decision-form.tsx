'use client';

import { useState } from 'react';
import { ELIGIBILITY_DECISION_LABELS } from '../../../lib/business-registration';
import { ConfirmDialog } from '../../../components/confirm-dialog';

type Decision = 'ELIGIBLE' | 'INELIGIBLE';

/**
 * The one decision a held event may receive (CMP-006 PR-C), asked twice
 * (ADMIN-DESIGN-001 Faz 3E).
 *
 * The form posts what it always posted — `eventId`, `decision`, `reason` —
 * to the same server action, which the API re-checks inside its own
 * transaction: a second or concurrent decision is a 409 sentence, never a
 * second decision. What changed is the last step: "Kararı kaydet" opens a
 * dialog that says what the chosen decision will do, once the decision and a
 * 10–1000 character reason are filled in (an empty field is the browser's to
 * report, before anyone is asked to confirm). The record id travels as
 * `eventId`, never as a field named "id".
 */
export function EligibilityDecisionForm({
  eventId,
  providerName,
  action,
}: {
  eventId: string;
  providerName: string;
  action: (formData: FormData) => void | Promise<void>;
}) {
  const [decision, setDecision] = useState<Decision | ''>('');

  return (
    <form action={action} className="detail-form" data-testid="eligibility-form">
      <input type="hidden" name="eventId" value={eventId} />
      <label className="detail-form-field" htmlFor="eligibility-decision">
        <span>Karar</span>
        <select
          id="eligibility-decision"
          name="decision"
          required
          value={decision}
          onChange={(event) => setDecision(event.target.value as Decision | '')}
          data-testid="eligibility-decision-select"
        >
          <option value="" disabled>
            Seçin
          </option>
          {(['ELIGIBLE', 'INELIGIBLE'] as const).map((value) => (
            <option key={value} value={value}>
              {ELIGIBILITY_DECISION_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      <label className="detail-form-field" htmlFor="eligibility-reason">
        <span>Gerekçe (10–1000 karakter, denetim kaydına yazılır)</span>
        <textarea
          id="eligibility-reason"
          name="reason"
          rows={4}
          required
          minLength={10}
          maxLength={1000}
          data-testid="eligibility-reason"
        />
      </label>
      <p className="detail-muted-note">
        Gerekçeye kimlik, vergi veya sicil numarası, telefon ya da IP adresi yazmayın. Karar bir kez verilir ve
        değiştirilemez; “Uygun” kararı olayı bir kez yeniden değerlendirmeye alır ve kampanya limitleri yine uygulanır.
      </p>
      <div className="detail-form-actions">
        <ConfirmDialog
          triggerLabel="Kararı kaydet"
          triggerClassName="btn btn-primary btn-sm"
          tone={decision === 'INELIGIBLE' ? 'danger' : 'primary'}
          title="Karar kesinleşsin mi?"
          consequence={<DecisionConsequence decision={decision} providerName={providerName} />}
          confirmLabel={decision === 'INELIGIBLE' ? 'Evet, uygun değil olarak kaydet' : 'Evet, uygun olarak kaydet'}
          testId="eligibility-submit"
        />
      </div>
    </form>
  );
}

/** What the API does with each decision (PromotionEligibilityReviewsService.decide). */
export function DecisionConsequence({ decision, providerName }: { decision: Decision | ''; providerName: string }) {
  return (
    <>
      {decision === 'ELIGIBLE' ? (
        <p>
          <strong>{providerName}</strong> için olay bir kez daha değerlendirme kuyruğuna alınır ve uygunluk sorusu
          yanıtlanmış olarak değerlendirilir. Kararın kendisi kredi vermez: kampanya koşulları ve limitleri yine uygulanır;
          kampanya motoru kapalıysa motor açılana kadar hiçbir şey verilmez.
        </p>
      ) : decision === 'INELIGIBLE' ? (
        <p>
          <strong>{providerName}</strong> için olay değerlendirilmiş sayılır ve bu olay için giriş promosyonu verilmez.
          Olay bir daha kuyruğa alınmaz.
        </p>
      ) : null}
      <p>
        Karar <strong>kesindir</strong>: bir kez verilir, sonradan değiştirilemez ya da geri alınamaz. Gerekçe adınızla
        denetim kaydına yazılır; hizmet verene e-posta gönderilmez.
      </p>
    </>
  );
}
