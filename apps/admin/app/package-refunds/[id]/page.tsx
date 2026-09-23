import Link from 'next/link';
import {
  apiFetch,
  fetchOrNotFound,
  formatDateTime,
  formatPrice,
  PACKAGE_REFUND_ACTOR_LABELS,
  PACKAGE_REFUND_EXCEPTION_GROUND_LABELS,
  PACKAGE_REFUND_EXCEPTION_GROUNDS,
  PACKAGE_REFUND_RECOMMENDATION_LABELS,
  packageRefundStatusBadgeClass,
  requireAdmin,
  type PackageRefundDetail,
  type PackageRefundEligibility,
} from '../../../lib/api';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import {
  approvePackageRefundAction,
  markPackageRefundSettlementFailedAction,
  rejectPackageRefundAction,
  takePackageRefundAction,
} from '../actions';

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ done?: string; error?: string }>;
};

const DONE_MESSAGES: Record<string, string> = {
  created: 'İade isteği açıldı.',
  taken: 'İstek işleme alındı.',
  approved: 'İstek onaylandı. Ödeme iadesini ödeme sağlayıcısının panelinde yapın; istek imzalı iade bildirimi gelince tamamlanır.',
  rejected: 'İstek reddedildi.',
  failed: 'Ödeme iadesinin tamamlanamadığı kaydedildi.',
};

/**
 * CMP-006 PR-B — one package refund request, everything that decided it, and
 * the actions this operator may take right now.
 *
 * The buttons are the API's `allowedActions` for *this* viewer: the maker of
 * an exception sees why they cannot approve it, and nobody sees a "refund
 * completed" button because none exists — SETTLED arrives only with the
 * payment provider's signed webhook. The purchase-terms evidence is shown as
 * the version and the moment it was accepted; the address, user agent and
 * text are not on this page.
 */
export default async function PackageRefundDetailPage({ params, searchParams }: PageProps) {
  await requireAdmin('PACKAGE_REFUND_READ');
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const refund = await fetchOrNotFound(() => apiFetch<PackageRefundDetail>(`/admin/package-refund-requests/${id}`));
  const actions = refund.allowedActions;
  const anyAction = Object.values(actions).some(Boolean);

  return (
    <main>
      <PageHeader
        breadcrumbs={[{ label: 'Paket İadeleri', href: '/package-refunds' }, { label: refund.purchase.packageName }]}
        title={`İade isteği · ${refund.purchase.packageName}`}
        subtitle={`${refund.provider.businessName} · Açılış: ${formatDateTime(refund.createdAt)}`}
        actions={
          <span className={packageRefundStatusBadgeClass(refund.status)} data-testid="package-refund-status" data-status={refund.status}>
            {refund.statusLabel}
          </span>
        }
      />

      {query.error ? (
        <div className="notice notice-error" role="alert" style={{ marginBottom: 12 }} data-testid="package-refund-error">
          {query.error}
        </div>
      ) : query.done && DONE_MESSAGES[query.done] ? (
        <div className="notice notice-success" role="status" style={{ marginBottom: 12 }} data-testid="package-refund-done">
          {DONE_MESSAGES[query.done]}
        </div>
      ) : null}

      <SectionCard title="Özet">
        <dl className="meta-row">
          <div>
            <dt>Hizmet veren</dt>
            <dd>{refund.provider.businessName}</dd>
          </div>
          <div>
            <dt>Satın alma</dt>
            <dd>
              {refund.purchase.purchaseNumber ?? refund.purchase.id} · {formatPrice(refund.purchase.priceAmount, refund.purchase.currency)} ·{' '}
              {refund.purchase.creditAmount} kredi
            </dd>
          </div>
          <div>
            <dt>Ödeme</dt>
            <dd>{refund.purchase.paidAt ? formatDateTime(refund.purchase.paidAt) : '—'}</dd>
          </div>
          <div>
            <dt>Destek talebi</dt>
            <dd>
              <Link href={`/support/${refund.supportTicket.id}`} data-testid="package-refund-ticket-link">
                {refund.supportTicket.subject}
              </Link>
            </dd>
          </div>
          <div>
            <dt>Açan</dt>
            <dd>
              {refund.origin === 'ADMIN' ? 'Yönetici' : 'Hizmet veren'} · {refund.createdBy.name ?? 'İsimsiz hesap'}
            </dd>
          </div>
          <div>
            <dt>Sözleşme kabulü</dt>
            <dd data-testid="package-refund-evidence">
              {refund.termsEvidence
                ? `Sürüm ${refund.termsEvidence.documentVersion} · ${formatDateTime(refund.termsEvidence.acceptedAt)}`
                : 'Kabul kanıtı yok'}
            </dd>
          </div>
        </dl>
      </SectionCard>

      <SectionCard title="Uygunluk (şimdi)" subtitle="Kanonik değerlendirme, bu sayfa açılırken yeniden hesaplandı. Onay anında API tekrar hesaplar.">
        <EligibilityBlock eligibility={refund.currentEligibility} testId="package-refund-current-eligibility" />
      </SectionCard>

      <SectionCard title="İşlemler">
        {!refund.flowOpen ? (
          <p className="notice notice-warning" data-testid="package-refund-flow-closed">
            İade akışı kapalı (satın alma koşulları kapısı). Yeni işleme alma ve onay yapılamaz; ret ve mutabakat kaydı yapılabilir.
          </p>
        ) : null}
        {refund.exceptionBlockedByMakerChecker ? (
          <p className="notice notice-warning" data-testid="package-refund-maker-checker">
            Bu isteği siz açtınız veya işleme aldınız. İstisna onayını ikinci bir yetkili vermelidir.
          </p>
        ) : null}
        {refund.status === 'APPROVED_PENDING_SETTLEMENT' ? (
          <p className="cell-muted" data-testid="package-refund-settlement-hint">
            Ödeme iadesini ödeme sağlayıcısının panelinde <strong>tam tutar</strong> olarak yapın. İstek, imzalı iade bildirimi
            geldiğinde kendiliğinden tamamlanır; TakTic&apos;te &quot;iade tamamlandı&quot; işaretlenemez.
          </p>
        ) : null}
        {!anyAction ? (
          <p className="cell-muted" data-testid="package-refund-no-actions">
            Bu isteğin şu anki durumunda sizin yapabileceğiniz bir işlem yok.
          </p>
        ) : null}

        <div style={{ display: 'grid', gap: 16 }}>
          {actions.take ? (
            <form action={takePackageRefundAction}>
              <input type="hidden" name="id" value={refund.id} />
              <button className="btn btn-primary btn-sm" type="submit" data-testid="package-refund-take">
                İşleme al
              </button>
            </form>
          ) : null}

          {actions.approveNormal ? (
            <form action={approvePackageRefundAction}>
              <input type="hidden" name="id" value={refund.id} />
              <input type="hidden" name="kind" value="NORMAL" />
              <button className="btn btn-primary btn-sm" type="submit" data-testid="package-refund-approve-normal">
                Normal iadeyi onayla
              </button>
            </form>
          ) : null}

          {actions.approveException ? (
            <form action={approvePackageRefundAction} data-testid="package-refund-exception-form">
              <input type="hidden" name="id" value={refund.id} />
              <input type="hidden" name="kind" value="EXCEPTION" />
              <label className="form-row" htmlFor="exception-ground">
                <span>İstisna gerekçesi</span>
                <select id="exception-ground" name="exceptionGround" required defaultValue="">
                  <option value="" disabled>
                    Seçin
                  </option>
                  {PACKAGE_REFUND_EXCEPTION_GROUNDS.map((ground) => (
                    <option key={ground} value={ground}>
                      {PACKAGE_REFUND_EXCEPTION_GROUND_LABELS[ground]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-row" htmlFor="exception-reason">
                <span>Açıklama (10–1000 karakter, denetim kaydına yazılır)</span>
                <textarea id="exception-reason" name="exceptionReason" rows={3} required minLength={10} maxLength={1000} />
              </label>
              <button className="btn btn-primary btn-sm" type="submit" data-testid="package-refund-approve-exception">
                İstisna olarak onayla
              </button>
            </form>
          ) : null}

          {actions.reject ? (
            <form action={rejectPackageRefundAction} data-testid="package-refund-reject-form">
              <input type="hidden" name="id" value={refund.id} />
              <label className="form-row" htmlFor="reject-reason">
                <span>Ret gerekçesi (10–1000 karakter, hizmet verene gösterilmez)</span>
                <textarea id="reject-reason" name="reason" rows={3} required minLength={10} maxLength={1000} />
              </label>
              <button className="btn btn-secondary btn-sm" type="submit" data-testid="package-refund-reject">
                Reddet
              </button>
            </form>
          ) : null}

          {actions.markSettlementFailed ? (
            <form action={markPackageRefundSettlementFailedAction} data-testid="package-refund-failed-form">
              <input type="hidden" name="id" value={refund.id} />
              <label className="form-row" htmlFor="failed-reason">
                <span>Ödeme iadesi neden tamamlanamadı? (10–1000 karakter)</span>
                <textarea id="failed-reason" name="reason" rows={3} required minLength={10} maxLength={1000} />
              </label>
              <button className="btn btn-secondary btn-sm" type="submit" data-testid="package-refund-mark-failed">
                Ödeme iadesi tamamlanamadı olarak kaydet
              </button>
            </form>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard title="Kararlar">
        <dl className="meta-row">
          <div>
            <dt>İşleme alan</dt>
            <dd>{refund.reviewStartedBy ? `${refund.reviewStartedBy.name ?? 'İsimsiz'} · ${formatDateTime(refund.reviewStartedAt!)}` : '—'}</dd>
          </div>
          <div>
            <dt>Onay</dt>
            <dd data-testid="package-refund-approval">
              {refund.approvedBy
                ? `${refund.approvalKind === 'EXCEPTION' ? 'İstisna' : 'Normal'} · ${refund.approvedBy.name ?? 'İsimsiz'} · ${formatDateTime(refund.approvedAt!)}`
                : '—'}
            </dd>
          </div>
          {refund.exceptionGround ? (
            <div>
              <dt>İstisna</dt>
              <dd>
                {PACKAGE_REFUND_EXCEPTION_GROUND_LABELS[refund.exceptionGround]} — {refund.exceptionReason}
              </dd>
            </div>
          ) : null}
          {refund.rejectionReason ? (
            <div>
              <dt>Ret</dt>
              <dd>
                {refund.rejectedBy?.name ?? 'İsimsiz'} — {refund.rejectionReason}
              </dd>
            </div>
          ) : null}
          {refund.settlementFailureReason ? (
            <div>
              <dt>Tamamlanamadı</dt>
              <dd>
                {refund.settlementFailedBy?.name ?? 'İsimsiz'} — {refund.settlementFailureReason}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Mutabakat</dt>
            <dd data-testid="package-refund-settlement">
              {refund.settledAt ? `İmzalı iade bildirimiyle tamamlandı · ${formatDateTime(refund.settledAt)}` : 'Bildirim bekleniyor / yok'}
            </dd>
          </div>
        </dl>
      </SectionCard>

      <SectionCard title="Başvuru anındaki uygunluk" subtitle="Talep açıldığında donmuş kopya; değişmez.">
        <EligibilityBlock eligibility={refund.submittedEligibility} testId="package-refund-submitted-eligibility" />
      </SectionCard>

      {refund.approvalEligibility ? (
        <SectionCard title="Onay anındaki uygunluk" subtitle="Onay transaction'ında yeniden hesaplanan ve kararla birlikte saklanan kopya.">
          <EligibilityBlock eligibility={refund.approvalEligibility} testId="package-refund-approval-eligibility" />
        </SectionCard>
      ) : null}

      <SectionCard title="Denetim kaydı">
        <ol className="support-timeline" data-testid="package-refund-audit">
          {refund.events.map((event) => (
            <li key={event.id} className="support-timeline-event" data-testid="package-refund-audit-entry" data-action={event.action}>
              <span>
                {event.statusLabel} — {PACKAGE_REFUND_ACTOR_LABELS[event.actorKind]}
                {event.actor?.name ? ` (${event.actor.name})` : ''}
                {event.note ? ` · ${event.note}` : ''}
              </span>
              <time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time>
            </li>
          ))}
        </ol>
      </SectionCard>
    </main>
  );
}

function EligibilityBlock({ eligibility, testId }: { eligibility: PackageRefundEligibility; testId: string }) {
  return (
    <div data-testid={testId} data-recommendation={eligibility.recommendation}>
      <p>
        <strong>{PACKAGE_REFUND_RECOMMENDATION_LABELS[eligibility.recommendation]}</strong> — {eligibility.summary}
      </p>
      <ul>
        {eligibility.reasons.map((reason) => (
          <li key={reason.code} className={reason.blocking ? undefined : 'cell-muted'}>
            {reason.blocking ? '✕ ' : '✓ '}
            {reason.explanation}
          </li>
        ))}
      </ul>
      <p className="cell-muted" style={{ fontSize: 12 }}>
        Değerlendirme: {formatDateTime(eligibility.evaluatedAt)}
        {eligibility.windowEndsAt ? ` · 14 günlük pencere sonu: ${formatDateTime(eligibility.windowEndsAt)}` : ''}
      </p>
    </div>
  );
}
