import Link from 'next/link';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import { KeyValueList } from '../../../components/key-value-list';
import { formatDate, formatDateTime } from '@taktic/shared';
import {
  MATCH_ROUND_OPENED_BY_LABELS,
  MATCH_ROUND_SOURCE_LABELS,
  matchRoundStatusBadgeClass,
  matchRoundStatusLabel,
  openNextRoundErrorMessage,
  openNextRoundTarget,
  ROUND_OPENING_NOTE_MAX_LENGTH,
  ROUND_OPENING_NOTE_MIN_LENGTH,
  SCHEDULE_MISSING_NOTE,
  type AdminRoundTimeline,
  type AdminRoundTimelineRound,
} from '../../../lib/match-rounds';
import { INCIDENT_DECISION_LABELS, PROVIDER_INCIDENT_STATUS_LABELS, SERVICE_ISSUE_REASON_LABELS } from '../../../lib/service-incidents';

type FormAction = (formData: FormData) => void | Promise<void>;

type Can = {
  openRound: boolean;
  openIncidents: boolean;
  openProviders: boolean;
  openReliability: boolean;
  openOffers: boolean;
};

/**
 * REL-002 Faz 5 — "Eşleşme turları": every round of the request, oldest
 * first, as the API recorded it. Read-only for every round; the one action is
 * "Yeni tur aç", offered only on a request waiting in MATCH_REVIEW, only to a
 * session holding MATCH_REVIEW_OPEN_ROUND (a super admin's alone), behind a
 * mandatory internal note and a confirmation.
 *
 * Each round is its own labelled `<article>`; a status is always written out
 * as text next to its colour.
 */
export function RoundTimelinePanel({
  timeline,
  can,
  action,
  idempotencyKey,
  roundError,
  roundOpened,
}: {
  timeline: AdminRoundTimeline;
  can: Can;
  /** `openNextRoundAction`, passed in so the panel stays a plain component. */
  action: FormAction;
  /** Minted when the page rendered: a double submit or a retry of this form is the same opening. */
  idempotencyKey: string;
  roundError: string | undefined;
  roundOpened: boolean;
}) {
  const target = openNextRoundTarget(timeline);
  const errorText = openNextRoundErrorMessage(roundError);
  const excludedBy = new Map(timeline.exclusions.map((exclusion) => [exclusion.sourceRoundId, exclusion]));

  return (
    <div className="round-timeline-panel" data-testid="round-timeline-panel">
      {roundOpened ? (
        <div className="notice-success detail-notice" role="status" data-testid="round-opened-notice">
          Yeni tur açıldı. Müşteriye bildirim gönderildi; dışlanan hizmet verenler bu turu göremez.
        </div>
      ) : null}
      {errorText ? (
        <div className="status-action-error" role="alert" data-testid="round-error">
          {errorText}
        </div>
      ) : null}

      {target ? (
        can.openRound ? (
          <OpenNextRoundForm
            action={action}
            requestId={timeline.requestId}
            failedRound={target}
            idempotencyKey={idempotencyKey}
            exclusionCount={timeline.exclusions.length}
          />
        ) : (
          <p className="status-reject-note" role="note" data-testid="round-open-reserved">
            Talep üç otomatik turdan sonra eşleşme incelemesinde. Yeni tur açmak yalnız süper yöneticiye açıktır.
          </p>
        )
      ) : null}

      <ol className="round-timeline" aria-label="Eşleşme turları, en eskiden en yeniye" data-testid="round-timeline">
        {timeline.rounds.map((round) => (
          <li key={round.id} className={round.isCurrent ? 'round-timeline-item is-current' : 'round-timeline-item'}>
            <RoundCard round={round} excluded={excludedBy.has(round.id)} can={can} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function RoundCard({ round, excluded, can }: { round: AdminRoundTimelineRound; excluded: boolean; can: Can }) {
  const headingId = `round-${round.roundNumber}-title`;
  const incident = round.failureIncident;
  const provider = round.matchedProvider ?? null;
  const offer = round.matchedOffer ?? null;

  return (
    <article className="round-card" aria-labelledby={headingId} data-testid="round-card" data-round={round.roundNumber}>
      <header className="round-card-head">
        <h3 id={headingId} className="round-card-title">
          Tur {round.roundNumber}
        </h3>
        <span className={matchRoundStatusBadgeClass(round.status)} data-testid="round-status">
          {matchRoundStatusLabel(round.status)}
        </span>
        {round.isCurrent ? <span className="badge badge-muted">Güncel tur</span> : null}
        {round.openedBy === 'ADMIN' ? (
          <span className="badge badge-warn" data-testid="round-admin-opened">
            Yönetici açtı
          </span>
        ) : null}
      </header>

      <KeyValueList
        items={[
          { label: 'Kaynak', value: MATCH_ROUND_SOURCE_LABELS[round.source] ?? round.source },
          { label: 'Açılış', value: `${MATCH_ROUND_OPENED_BY_LABELS[round.openedBy] ?? round.openedBy} · ${formatDateTime(round.openedAt)}` },
          {
            label: 'Yayın',
            value: round.publishedAt ? (
              formatDateTime(round.publishedAt)
            ) : round.status === 'OPEN' ? (
              <span className="cell-muted">Yayın bekliyor (moderasyon)</span>
            ) : (
              <span className="cell-muted">Yayınlanmadı</span>
            ),
          },
          { label: 'Yayın sonu', value: round.expiresAt ? formatDateTime(round.expiresAt) : null },
          { label: 'Gelen teklif', value: String(round.offerCount) },
          { label: 'Eşleşme', value: round.matchedAt ? formatDateTime(round.matchedAt) : null },
          ...outcomeRows(round),
          ...(round.matchedOfferId
            ? [
                {
                  label: 'Eşleşen hizmet veren',
                  value: provider ? (
                    can.openProviders ? (
                      <Link className="cell-link" href={`/providers/${provider.id}`}>
                        {provider.businessName}
                      </Link>
                    ) : (
                      provider.businessName
                    )
                  ) : (
                    <span className="cell-muted">Teklif okuma izniniz yok</span>
                  ),
                },
                ...(offer
                  ? [
                      {
                        label: 'Kabul edilen teklif',
                        value: can.openOffers ? (
                          <Link className="cell-link" href={`/offers/${offer.id}`}>
                            {offer.offerNumber ?? `#${offer.id.slice(-8)}`}
                          </Link>
                        ) : (
                          (offer.offerNumber ?? `#${offer.id.slice(-8)}`)
                        ),
                      },
                      {
                        label: 'Taahhüt günleri',
                        value:
                          offer.estimatedStartDate && offer.estimatedCompletionDate
                            ? `${formatDate(offer.estimatedStartDate)} – ${formatDate(offer.estimatedCompletionDate)}`
                            : null,
                      },
                    ]
                  : []),
              ]
            : []),
          ...(round.winnerScheduleMissing && round.status === 'MATCHED'
            ? [
                {
                  label: 'Sorun bildirimi',
                  value: (
                    <span data-testid="round-schedule-missing">
                      {SCHEDULE_MISSING_NOTE}. Müşteri destek yoluna yönlendirilir.
                    </span>
                  ),
                },
              ]
            : []),
          ...(incident
            ? [
                {
                  label: 'Hizmet aksaklığı',
                  value: (
                    <span className="cell-stack" data-testid="round-incident">
                      {can.openIncidents ? (
                        <Link className="cell-link" href={`/service-incidents/${incident.id}`}>
                          {incident.incidentNumber}
                        </Link>
                      ) : (
                        <code>{incident.incidentNumber}</code>
                      )}
                      <span>
                        {SERVICE_ISSUE_REASON_LABELS[incident.reason] ?? incident.reason} · {formatDateTime(incident.reportedAt)}
                      </span>
                      <span>
                        Durum: {PROVIDER_INCIDENT_STATUS_LABELS[incident.status] ?? incident.status}
                        {incident.effectiveDecision
                          ? ` · Geçerli karar: ${INCIDENT_DECISION_LABELS[incident.effectiveDecision]}${incident.corrected ? ' (düzeltildi)' : ''}`
                          : ' · Karar bekliyor'}
                      </span>
                      {can.openReliability ? (
                        <Link className="cell-link" href={`/providers/${incident.providerId}#guvenilirlik`}>
                          Hizmet verenin güvenilirlik kaydı
                        </Link>
                      ) : null}
                    </span>
                  ),
                },
              ]
            : []),
          ...(excluded
            ? [{ label: 'Dışlama', value: 'Bu turun hizmet vereni talepten kalıcı olarak dışlandı.' }]
            : []),
          {
            label: 'Mesajlaşma',
            value: round.thread ? (
              round.thread.mode === 'ACTIVE' ? 'Açık yazışma' : 'Kapandı · salt okunur'
            ) : (
              <span className="cell-muted">Yazışma yok</span>
            ),
          },
          ...(round.contactRevealed === undefined
            ? []
            : [{ label: 'İletişim paylaşımı', value: round.contactRevealed ? 'Paylaşıldı' : 'Paylaşılmadı' }]),
          ...(round.opening
            ? [
                {
                  label: 'Turu açan yönetici',
                  value: `${round.opening.openedBy.name ?? round.opening.openedBy.id} · ${formatDateTime(round.opening.createdAt)}`,
                },
                {
                  label: 'İç not',
                  value: (
                    <span className="request-description" data-testid="round-opening-note">
                      {round.opening.note}
                    </span>
                  ),
                },
              ]
            : []),
        ]}
      />
    </article>
  );
}

function outcomeRows(round: AdminRoundTimelineRound) {
  const rows: Array<{ label: string; value: string }> = [];
  if (round.completedAt) rows.push({ label: 'Tamamlanma', value: formatDateTime(round.completedAt) });
  if (round.failedAt) rows.push({ label: 'Başarısız', value: formatDateTime(round.failedAt) });
  if (round.cancelledAt) rows.push({ label: 'İptal', value: formatDateTime(round.cancelledAt) });
  if (round.expiredAt) rows.push({ label: 'Süre dolumu', value: formatDateTime(round.expiredAt) });
  return rows;
}

/**
 * "Yeni tur aç" — Round N+1 on the same request. The failed round the operator
 * is looking at and the idempotency key travel as hidden fields; the note is
 * mandatory and internal. The confirmation says exactly what happens and what
 * does not; the pending submission disables the button (ConfirmDialog), and a
 * second submission with the same key is the same opening.
 */
function OpenNextRoundForm({
  action,
  requestId,
  failedRound,
  idempotencyKey,
  exclusionCount,
}: {
  action: FormAction;
  requestId: string;
  failedRound: AdminRoundTimelineRound;
  idempotencyKey: string;
  exclusionCount: number;
}) {
  const nextNumber = failedRound.roundNumber + 1;
  return (
    <form action={action} className="refund-action detail-form" data-testid="open-next-round-form">
      <input type="hidden" name="id" value={requestId} />
      <input type="hidden" name="expectedCurrentRoundId" value={failedRound.id} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <p className="refund-action-title">Yeni tur aç (Tur {nextNumber})</p>
      <p className="report-decisions-intro" id="open-next-round-intro">
        Talep, {failedRound.roundNumber}. tur başarısız olduğu için eşleşme incelemesinde. Yeni tur aynı talep üzerinde
        açılır ve normal yayın kapısından geçer.
      </p>
      <label className="detail-form-field" htmlFor="open-next-round-note">
        <span>
          İç not ({ROUND_OPENING_NOTE_MIN_LENGTH}–{ROUND_OPENING_NOTE_MAX_LENGTH} karakter, zorunlu; müşteri ve hizmet
          veren görmez)
        </span>
        <textarea
          id="open-next-round-note"
          name="note"
          rows={4}
          required
          minLength={ROUND_OPENING_NOTE_MIN_LENGTH}
          maxLength={ROUND_OPENING_NOTE_MAX_LENGTH}
          aria-describedby="open-next-round-intro"
          data-testid="open-next-round-note"
        />
      </label>
      <div className="detail-form-actions">
        <ConfirmDialog
          proof="request.open-next-round"
          triggerLabel="Yeni tur aç"
          triggerClassName="btn btn-primary btn-sm"
          tone="primary"
          title={`Tur ${nextNumber} açılsın mı?`}
          consequence={
            <>
              <p>
                Talep için <strong>Tur {nextNumber}</strong> açılır. Otomatik yayın açıksa talep hemen yeniden
                yayınlanır; kapalıysa moderasyon kuyruğuna düşer. Müşteriye “talebiniz yeniden teklif almaya açıldı”
                bildirimi gider; iç not gösterilmez.
              </p>
              <p>
                Önceki turlar, teklifleri, yazışmaları ve hizmet aksaklığı kayıtları değişmez. Bu talepten dışlanan{' '}
                {exclusionCount} hizmet veren dışlanmış kalır. <strong>Kredi iadesi yapılmaz</strong>; yeni turda
                teklifler normal fiyatla verilir.
              </p>
              <p>Açılış adınızla ve notunuzla kalıcı olarak kaydedilir; geri alınamaz ve not sonradan düzenlenemez.</p>
            </>
          }
          confirmLabel={`Evet, Tur ${nextNumber}'i aç`}
          testId="open-next-round"
          confirmTestId="open-next-round-submit"
        />
      </div>
    </form>
  );
}
