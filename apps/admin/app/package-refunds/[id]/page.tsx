import Link from 'next/link';
import {
  apiFetch,
  fetchOrNotFound,
  formatDateTime,
  formatPrice,
  PACKAGE_REFUND_ACTOR_LABELS,
  PACKAGE_REFUND_EXCEPTION_GROUND_LABELS,
  PACKAGE_REFUND_RECOMMENDATION_LABELS,
  packageRefundStatusBadgeClass,
  requireAdmin,
  type PackageRefundDetail,
  type PackageRefundEligibility,
} from '../../../lib/api';
import { formatCount } from '../../../lib/pagination';
import { DetailHeader } from '../../../components/detail-header';
import { KeyValueList } from '../../../components/key-value-list';
import { SectionCard } from '../../../components/section-card';
import type { SummaryItem } from '../../../components/summary-strip';
import {
  approvePackageRefundAction,
  markPackageRefundSettlementFailedAction,
  rejectPackageRefundAction,
  takePackageRefundAction,
} from '../actions';
import { RefundActions } from './refund-actions';

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
 *
 * ADMIN-DESIGN-001 Faz 3D: the design has no screen for a refund request, so
 * it takes the shared detail template — summary card and strip, then the seven
 * sections the screen always had (operations, summary, eligibility now, the
 * decisions, eligibility at submission, eligibility at approval, the audit
 * trail). The four decisions now ask first (`RefundActions`); what the API
 * accepts and refuses is unchanged.
 */
export default async function PackageRefundDetailPage({ params, searchParams }: PageProps) {
  // The action buttons need no gate here: `allowedActions` is computed by the
  // API for this viewer's permissions (package-refund-requests.service.ts).
  await requireAdmin('PACKAGE_REFUND_READ');
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const refund = await fetchOrNotFound(() => apiFetch<PackageRefundDetail>(`/admin/package-refund-requests/${id}`));
  const actions = refund.allowedActions;
  const anyAction = Object.values(actions).some(Boolean);
  const price = formatPrice(refund.purchase.priceAmount, refund.purchase.currency);
  const purchaseRef = refund.purchase.purchaseNumber ?? refund.purchase.id;

  const facts: SummaryItem[] = [
    { label: 'Tutar', value: price, testId: 'package-refund-fact-amount' },
    { label: 'Kredi', value: formatCount(refund.purchase.creditAmount) },
    { label: 'Ödeme', value: refund.purchase.paidAt ? formatDateTime(refund.purchase.paidAt) : '—' },
    {
      label: 'Uygunluk (şimdi)',
      value: PACKAGE_REFUND_RECOMMENDATION_LABELS[refund.currentEligibility.recommendation],
    },
    {
      label: 'Onay',
      value:
        refund.approvalKind === 'EXCEPTION'
          ? 'İstisna'
          : refund.approvalKind === 'NORMAL'
            ? 'Normal'
            : '—',
    },
  ];

  return (
    <main className="refund-detail-page">
      <DetailHeader
        back={{ href: '/package-refunds', label: 'Paket iadeleri' }}
        badges={
          <span
            className={packageRefundStatusBadgeClass(refund.status)}
            data-testid="package-refund-status"
            data-status={refund.status}
          >
            {refund.statusLabel}
          </span>
        }
        meta={
          <>
            <code className="cell-break">{purchaseRef}</code> · Açılış: {formatDateTime(refund.createdAt)}
          </>
        }
        title={`İade isteği · ${refund.purchase.packageName}`}
        subtitle={`${refund.provider.businessName} · ${refund.origin === 'ADMIN' ? 'Yönetici açtı' : 'Hizmet veren açtı'}`}
        facts={facts}
        factsLabel="İade isteği özeti"
        testId="package-refund-header"
      />

      {query.error ? (
        <div className="notice notice-error detail-notice" role="alert" data-testid="package-refund-error">
          {query.error}
        </div>
      ) : query.done && DONE_MESSAGES[query.done] ? (
        <div className="notice notice-success detail-notice" role="status" data-testid="package-refund-done">
          {DONE_MESSAGES[query.done]}
        </div>
      ) : null}

      <div className="detail-panel detail-panel-grid">
        <section className="is-wide" id="islemler">
          <SectionCard title="İşlemler">
            <div className="refund-notices">
              {!refund.flowOpen ? (
                <p className="notice notice-warning" data-testid="package-refund-flow-closed">
                  İade akışı kapalı (satın alma koşulları kapısı). Yeni işleme alma ve onay yapılamaz; ret ve mutabakat
                  kaydı yapılabilir.
                </p>
              ) : null}
              {refund.exceptionBlockedByMakerChecker ? (
                <p className="notice notice-warning" data-testid="package-refund-maker-checker">
                  Bu isteği siz açtınız veya işleme aldınız. İstisna onayını ikinci bir yetkili vermelidir.
                </p>
              ) : null}
              {refund.status === 'APPROVED_PENDING_SETTLEMENT' ? (
                <p className="detail-muted-note" data-testid="package-refund-settlement-hint">
                  Ödeme iadesini ödeme sağlayıcısının panelinde <strong>tam tutar</strong> olarak yapın. İstek, imzalı
                  iade bildirimi geldiğinde kendiliğinden tamamlanır; TakTic&apos;te &quot;iade tamamlandı&quot;
                  işaretlenemez.
                </p>
              ) : null}
              {refund.status === 'SETTLEMENT_FAILED' ? (
                <p className="detail-muted-note" data-testid="package-refund-failed-hint">
                  Dış iade henüz mutabık değil. İstek, ödeme sağlayıcısından gelecek ve tam iadeyi kanıtlayan imzalı bir
                  bildirimle kendiliğinden tamamlanabilir; TakTic&apos;te elle tamamlanamaz.
                </p>
              ) : null}
              {!anyAction ? (
                <p className="detail-muted-note" data-testid="package-refund-no-actions">
                  Bu isteğin şu anki durumunda sizin yapabileceğiniz bir işlem yok.
                </p>
              ) : null}
            </div>

            {anyAction ? (
              <RefundActions
                refundId={refund.id}
                allowedActions={actions}
                priceLabel={price}
                formActions={{
                  take: takePackageRefundAction,
                  approve: approvePackageRefundAction,
                  reject: rejectPackageRefundAction,
                  markSettlementFailed: markPackageRefundSettlementFailedAction,
                }}
              />
            ) : null}
          </SectionCard>
        </section>

        <SectionCard title="Özet">
          <KeyValueList
            items={[
              { label: 'Hizmet veren', value: refund.provider.businessName },
              {
                label: 'Satın alma',
                value: `${purchaseRef} · ${price} · ${formatCount(refund.purchase.creditAmount)} kredi`,
              },
              { label: 'Ödeme', value: refund.purchase.paidAt ? formatDateTime(refund.purchase.paidAt) : '—' },
              {
                label: 'Destek talebi',
                // The ticket's subject is the support desk's: the API sends it only
                // with SUPPORT_READ, and the link opens a screen that needs it too.
                value: refund.supportTicket ? (
                  <Link href={`/support/${refund.supportTicket.id}`} data-testid="package-refund-ticket-link">
                    {refund.supportTicket.subject}
                  </Link>
                ) : (
                  <span className="cell-muted" data-testid="package-refund-ticket-hidden">
                    Bağlı — içeriği destek okuma yetkisiyle görünür
                  </span>
                ),
              },
              {
                label: 'Açan',
                value: `${refund.origin === 'ADMIN' ? 'Yönetici' : 'Hizmet veren'} · ${refund.createdBy.name ?? 'İsimsiz hesap'}`,
              },
              {
                label: 'Sözleşme kabulü',
                value: refund.termsEvidence
                  ? `Sürüm ${refund.termsEvidence.documentVersion} · ${formatDateTime(refund.termsEvidence.acceptedAt)}`
                  : 'Kabul kanıtı yok',
                testId: 'package-refund-evidence',
              },
            ]}
          />
        </SectionCard>

        <SectionCard
          title="Uygunluk (şimdi)"
          subtitle="Kanonik değerlendirme, bu sayfa açılırken yeniden hesaplandı. Onay anında API tekrar hesaplar."
        >
          <EligibilityBlock eligibility={refund.currentEligibility} testId="package-refund-current-eligibility" />
        </SectionCard>

        <SectionCard title="Kararlar">
          <KeyValueList
            items={[
              {
                label: 'İşleme alan',
                value: refund.reviewStartedBy
                  ? `${refund.reviewStartedBy.name ?? 'İsimsiz'} · ${formatDateTime(refund.reviewStartedAt!)}`
                  : '—',
              },
              {
                label: 'Onay',
                value: refund.approvedBy
                  ? `${refund.approvalKind === 'EXCEPTION' ? 'İstisna' : 'Normal'} · ${refund.approvedBy.name ?? 'İsimsiz'} · ${formatDateTime(refund.approvedAt!)}`
                  : '—',
                testId: 'package-refund-approval',
              },
              ...(refund.exceptionGround
                ? [
                    {
                      label: 'İstisna',
                      value: `${PACKAGE_REFUND_EXCEPTION_GROUND_LABELS[refund.exceptionGround]} — ${refund.exceptionReason}`,
                    },
                  ]
                : []),
              ...(refund.rejectionReason
                ? [{ label: 'Ret', value: `${refund.rejectedBy?.name ?? 'İsimsiz'} — ${refund.rejectionReason}` }]
                : []),
              ...(refund.settlementFailureReason
                ? [
                    {
                      label: 'Tamamlanamadı',
                      value: `${
                        refund.settlementFailedByWebhook
                          ? 'Ödeme sağlayıcısı bildirimi'
                          : (refund.settlementFailedBy?.name ?? 'İsimsiz')
                      } — ${refund.settlementFailureReason}`,
                    },
                  ]
                : []),
              {
                label: 'Mutabakat',
                value: refund.settledAt
                  ? `İmzalı iade bildirimiyle tamamlandı · ${formatDateTime(refund.settledAt)}`
                  : refund.status === 'SETTLEMENT_FAILED'
                    ? 'Tamamlanmadı — kanıtlanmış tam iade bildirimi bekleniyor'
                    : 'Bildirim bekleniyor / yok',
                testId: 'package-refund-settlement',
              },
            ]}
          />
        </SectionCard>

        <SectionCard title="Başvuru anındaki uygunluk" subtitle="Talep açıldığında donmuş kopya; değişmez.">
          <EligibilityBlock eligibility={refund.submittedEligibility} testId="package-refund-submitted-eligibility" />
        </SectionCard>

        {refund.approvalEligibility ? (
          <SectionCard
            title="Onay anındaki uygunluk"
            subtitle="Onay transaction'ında yeniden hesaplanan ve kararla birlikte saklanan kopya."
          >
            <EligibilityBlock eligibility={refund.approvalEligibility} testId="package-refund-approval-eligibility" />
          </SectionCard>
        ) : null}

        <section className="is-wide">
          <SectionCard title="Denetim kaydı" subtitle="Bu isteğe olan her şey, eskiden yeniye.">
            <ol className="timeline" data-testid="package-refund-audit">
              {refund.events.map((event) => (
                <li
                  key={event.id}
                  className="timeline-item"
                  data-testid="package-refund-audit-entry"
                  data-action={event.action}
                >
                  <time className="timeline-when" dateTime={event.createdAt}>
                    {formatDateTime(event.createdAt)}
                  </time>
                  <div className="timeline-body">
                    <p className="timeline-title">{event.statusLabel}</p>
                    <p className="timeline-meta">
                      {PACKAGE_REFUND_ACTOR_LABELS[event.actorKind]}
                      {event.actor?.name ? ` (${event.actor.name})` : ''}
                    </p>
                    {event.note ? <p className="timeline-meta">{event.note}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
          </SectionCard>
        </section>
      </div>
    </main>
  );
}

function EligibilityBlock({ eligibility, testId }: { eligibility: PackageRefundEligibility; testId: string }) {
  return (
    <div className="eligibility-block" data-testid={testId} data-recommendation={eligibility.recommendation}>
      <p className="eligibility-summary">
        <span className={eligibility.recommendation === 'REFUNDABLE' ? 'badge badge-good' : eligibility.recommendation === 'EXCEPTION_ONLY' ? 'badge badge-warn' : 'badge badge-bad'}>
          {PACKAGE_REFUND_RECOMMENDATION_LABELS[eligibility.recommendation]}
        </span>{' '}
        {eligibility.summary}
      </p>
      <ul className="eligibility-reasons">
        {eligibility.reasons.map((reason) => (
          <li key={reason.code} className={reason.blocking ? 'is-blocking' : 'is-ok'}>
            <span aria-hidden="true">{reason.blocking ? '✕ ' : '✓ '}</span>
            <span className="sr-only">{reason.blocking ? 'Engel: ' : 'Uygun: '}</span>
            {reason.explanation}
          </li>
        ))}
      </ul>
      <p className="detail-muted-note">
        Değerlendirme: {formatDateTime(eligibility.evaluatedAt)}
        {eligibility.windowEndsAt ? ` · 14 günlük pencere sonu: ${formatDateTime(eligibility.windowEndsAt)}` : ''}
      </p>
    </div>
  );
}
