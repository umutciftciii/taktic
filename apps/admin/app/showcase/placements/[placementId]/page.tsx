import Link from 'next/link';
import {
  apiFetch,
  fetchOrNotFound,
  formatDateTime,
  formatPrice,
  requireAdmin,
  showcasePlacementBadgeClass,
  SHOWCASE_CARD_KIND_LABELS,
  SHOWCASE_PLACEMENT_STATUS_LABELS,
  SHOWCASE_SUSPEND_REASON_LABELS,
  type ShowcasePlacement,
} from '../../../../lib/api';
import { ConfirmDialog } from '../../../../components/confirm-dialog';
import { DataTable, type DataColumn } from '../../../../components/data-table';
import { DetailHeader } from '../../../../components/detail-header';
import { KeyValueList } from '../../../../components/key-value-list';
import { SectionCard } from '../../../../components/section-card';
import type { SummaryItem } from '../../../../components/summary-strip';
import {
  cancelShowcasePlacementAction,
  resumeShowcasePlacementAction,
  suspendShowcasePlacementAction,
} from '../actions';

type PlacementPageProps = {
  params: Promise<{ placementId: string }>;
  searchParams: Promise<{
    error?: string;
    suspended?: string;
    resumed?: string;
    cancelled?: string;
  }>;
};

const ERRORS: Record<string, string> = {
  SHOWCASE_PLACEMENT_NOT_FOUND: 'Yerleşim bulunamadı.',
  SHOWCASE_PLACEMENT_NOT_SUSPENDABLE: 'Yalnız yayında olan bir yerleşim durdurulabilir.',
  SHOWCASE_PLACEMENT_NOT_RESUMABLE:
    'Bu yerleşim operatör kararıyla durdurulmuş bir yerleşim değil. Diğer durdurma sebepleri, sebep ortadan kalktığında kendiliğinden kalkar.',
  SHOWCASE_PLACEMENT_NOT_CANCELLABLE: 'Yalnız süresi devam eden bir yerleşim iptal edilebilir.',
  SHOWCASE_PLACEMENT_ACTION_FAILED: 'İşlem tamamlanamadı.',
};

/**
 * One paid run: what was sold, what it is publishing, and everything that has
 * happened to it.
 *
 * ADMIN-DESIGN-001 Faz 3C: the design has no screen for one run (`soon`), so
 * it sits on the shared detail template. Cancelling — the one irreversible
 * action here — asks first, in a dialog that says what the API really does
 * (CANCEL_CONSEQUENCE); closing it writes nothing.
 *
 * ## The suspension table is the interesting part
 *
 * It has an "extends clock" column, and the column is a snapshot rather than a
 * reading of today's rule. That matters when somebody looks back: whether a
 * suspension in March gave the provider their days back is a fact about March,
 * and it must not change because the policy changed in June. A CHECK enforces
 * the consequence — a suspension that did not stop the clock can never record a
 * different end date than it started with.
 *
 * ## Why resume only lifts an operator's own hold
 *
 * The other five reasons lift when the thing behind them goes away, and the
 * code that changes that thing resumes the run in the same transaction. An
 * operator "resuming" a run held down by a closed category would put a card back
 * on a shelf the platform has closed.
 */
export default async function ShowcasePlacementPage({
  params,
  searchParams,
}: PlacementPageProps) {
  const { can } = await requireAdmin('SHOWCASE_PLACEMENTS_READ');
  const canModerate = can('SHOWCASE_PLACEMENTS_MODERATE');
  const canCancel = can('SHOWCASE_PLACEMENT_CANCEL');
  const canOpenProvider = can('PROVIDERS_READ_DETAIL');
  const canOpenReview = can('SHOWCASE_REVIEW_READ');

  const { placementId } = await params;
  const { error, suspended, resumed, cancelled } = await searchParams;
  const placement = await fetchOrNotFound(() =>
    apiFetch<ShowcasePlacement>(`/admin/showcase/placements/${placementId}`),
  );

  const isAdminHold = placement.suspendReason === 'ADMIN_ACTION';
  const isLive =
    placement.status === 'ACTIVE' ||
    placement.status === 'PENDING_ACTIVATION' ||
    placement.status === 'SUSPENDED';

  const facts: SummaryItem[] = [
    { label: 'Paket', value: placement.packageName, note: `${placement.durationDays} gün` },
    // What TakTick charged for the listing. Never shown beside the card's own
    // service price, which is the provider's money.
    { label: 'Yayın bedeli', value: formatPrice(placement.priceAmount, placement.currency) },
    { label: 'Başlangıç', value: formatDateTime(placement.startAt) },
    {
      label: 'Bitiş',
      value: formatDateTime(placement.endAt),
      note: placement.extendedDays > 0 ? `durdurmalar nedeniyle +${placement.extendedDays} gün` : undefined,
    },
    { label: 'Gelen talep', value: String(placement.leadCount) },
  ];

  return (
    <main className="showcase-placement-detail-page">
      <DetailHeader
        back={{ href: '/showcase/placements', label: 'Yayında olan kartlar' }}
        badges={
          <span className={showcasePlacementBadgeClass(placement.status)} data-testid="placement-status">
            {SHOWCASE_PLACEMENT_STATUS_LABELS[placement.status]}
          </span>
        }
        meta={
          placement.suspendReason
            ? SHOWCASE_SUSPEND_REASON_LABELS[placement.suspendReason]
            : placement.cancelledAt
              ? `İptal: ${formatDateTime(placement.cancelledAt)}`
              : `${SHOWCASE_CARD_KIND_LABELS[placement.kind]} · ${placement.category.name}`
        }
        title={placement.version.title}
        subtitle={`${placement.provider?.businessName ?? '—'} · ${SHOWCASE_CARD_KIND_LABELS[placement.kind]} · ${placement.category.name}`}
        facts={facts}
        factsLabel="Yerleşim özeti"
        testId="placement-header"
      />

      {error ? (
        <div className="notice notice-error detail-notice" role="alert" data-testid="placement-error">
          {ERRORS[error] ?? ERRORS.SHOWCASE_PLACEMENT_ACTION_FAILED}
        </div>
      ) : null}
      {suspended ? (
        <div className="notice detail-notice" role="status">
          Yerleşim durduruldu ve yayından kaldırıldı. Süre işlemiyor; sürdürdüğünüzde durdurma
          süresi kadar uzatılacak.
        </div>
      ) : null}
      {resumed ? (
        <div className="notice detail-notice" role="status">
          Yerleşim yeniden yayında. Durdurma süresi bitiş tarihine eklendi.
        </div>
      ) : null}
      {cancelled ? (
        <div className="notice notice-warning detail-notice" role="status" data-testid="placement-cancelled-notice">
          Yerleşim iptal edildi. <strong>Para iadesi yapılmadı</strong> — ilgili satın alma
          manuel inceleme için işaretlendi.
        </div>
      ) : null}

      <div className="detail-panel">
        <SectionCard title="Yerleşim">
          <KeyValueList
            items={[
              {
                label: 'Durum',
                value: (
                  <>
                    <span className={showcasePlacementBadgeClass(placement.status)}>
                      {SHOWCASE_PLACEMENT_STATUS_LABELS[placement.status]}
                    </span>
                    {placement.suspendReason ? (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {SHOWCASE_SUSPEND_REASON_LABELS[placement.suspendReason]}
                      </div>
                    ) : null}
                  </>
                ),
              },
              {
                label: 'İşletme',
                value:
                  placement.provider && canOpenProvider ? (
                    <Link href={`/providers/${placement.provider.id}`}>{placement.provider.businessName}</Link>
                  ) : (
                    (placement.provider?.businessName ?? '—')
                  ),
              },
              { label: 'Paket', value: `${placement.packageName} · ${placement.durationDays} gün` },
              { label: 'Yayın bedeli', value: formatPrice(placement.priceAmount, placement.currency) },
              { label: 'Başlangıç', value: formatDateTime(placement.startAt) },
              {
                label: 'Bitiş',
                value: (
                  <>
                    {formatDateTime(placement.endAt)}
                    {placement.extendedDays > 0 ? (
                      <div className="muted" style={{ fontSize: 12 }}>
                        Durdurmalar nedeniyle {placement.extendedDays} gün eklendi
                      </div>
                    ) : null}
                  </>
                ),
              },
              ...(placement.cancelledAt
                ? [
                    { label: 'İptal zamanı', value: formatDateTime(placement.cancelledAt) },
                    {
                      label: 'İptal eden',
                      value: placement.cancellation ? (
                        <span data-testid="placement-cancelled-by">
                          {placement.cancellation.actor.name ?? 'Adı olmayan personel hesabı'}
                          {placement.cancellation.note ? (
                            <div className="muted" style={{ fontSize: 12 }}>
                              Not: {placement.cancellation.note}
                            </div>
                          ) : null}
                        </span>
                      ) : (
                        // A run cancelled before the operator was recorded. The
                        // actor is unknown, not missing by accident — no name is
                        // guessed for it.
                        <span className="muted" data-testid="placement-cancelled-by-unknown">
                          Kayıt yok — bu iptal, iptal edenin kaydedilmeye başlanmasından önce yapıldı
                        </span>
                      ),
                    },
                  ]
                : []),
              {
                label: 'Yayındaki sürüm',
                value: canOpenReview ? (
                  <Link href={`/showcase/reviews/${placement.version.id}`}>v{placement.version.versionNumber}</Link>
                ) : (
                  `v${placement.version.versionNumber}`
                ),
              },
              { label: 'Gelen talep', value: String(placement.leadCount) },
              {
                label: 'Raflar',
                value: (
                  <ul className="plain-list">
                    {placement.areas.map((area) => (
                      <li key={area.id}>
                        {area.label}
                        {!area.active ? <span className="muted"> · yayında değil</span> : null}
                      </li>
                    ))}
                  </ul>
                ),
              },
            ]}
          />
        </SectionCard>

        {placement.suspensions && placement.suspensions.length > 0 ? (
          <SectionCard
            title="Durdurma geçmişi"
            subtitle="“Süre durdu” sütunu, durdurma açıldığı anda alınan bir kopyadır; kural sonradan değişse bile bu satırlar değişmez."
            padded={false}
          >
            <DataTable
              caption="Durdurma geçmişi"
              columns={SUSPENSION_COLUMNS}
              minWidth={760}
              testId="placement-suspensions"
            >
              {placement.suspensions.map((suspension) => (
                <tr key={suspension.id}>
                  <td>{SHOWCASE_SUSPEND_REASON_LABELS[suspension.reason]}</td>
                  <td>
                    <span className={suspension.extendsClock ? 'badge badge-good' : 'badge badge-muted'}>
                      {suspension.extendsClock ? 'Evet' : 'Hayır'}
                    </span>
                  </td>
                  <td>{formatDateTime(suspension.startedAt)}</td>
                  <td>{suspension.endedAt ? formatDateTime(suspension.endedAt) : 'Sürüyor'}</td>
                  <td>
                    {formatDateTime(suspension.endAtBefore)}
                    {suspension.endAtAfter ? (
                      <div className="muted" style={{ fontSize: 12 }}>
                        → {formatDateTime(suspension.endAtAfter)}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    {suspension.actor?.name ?? (suspension.actor ? 'Operatör' : 'Sistem')}
                    {suspension.note ? (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {suspension.note}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </DataTable>
          </SectionCard>
        ) : null}

        {placement.versionChanges && placement.versionChanges.length > 0 ? (
          <SectionCard
            title="Sürüm değişiklikleri"
            subtitle="Yerleşim, kartın yayındaki sürümünü takip eder; kart sayfası ile ana sayfa farklı metin göstermez."
            padded={false}
          >
            <DataTable caption="Sürüm değişiklikleri" columns={VERSION_CHANGE_COLUMNS} minWidth={480}>
              {placement.versionChanges.map((change) => (
                <tr key={change.id}>
                  <td>{formatDateTime(change.createdAt)}</td>
                  <td>{change.trigger === 'ADMIN_APPROVAL' ? 'Operatör onayı' : 'Sağlayıcı bölge daralttı'}</td>
                  <td>
                    {canOpenReview ? (
                      <Link href={`/showcase/reviews/${change.toVersionId}`}>Yeni sürüm</Link>
                    ) : (
                      'Yeni sürüm'
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
          </SectionCard>
        ) : null}

        {placement.status === 'ACTIVE' && canModerate ? (
          <SectionCard
            title="Yayından kaldır"
            subtitle="Operatör kararıyla durdurmak süreyi durdurur: durdurma boyunca geçen süre, sürdürüldüğünde bitiş tarihine eklenir."
          >
            <form action={suspendShowcasePlacementAction} className="form-grid">
              <input type="hidden" name="placementId" value={placementId} />
              <label className="form-grid-wide">
                <span>Not</span>
                <textarea name="note" maxLength={500} placeholder="Kayda geçecek gerekçe" />
              </label>
              <div className="form-actions form-grid-wide">
                <button className="btn btn-danger" type="submit">
                  Yerleşimi durdur
                </button>
              </div>
            </form>
          </SectionCard>
        ) : null}

        {placement.status === 'SUSPENDED' && canModerate ? (
          <SectionCard
            title="Yayına al"
            subtitle={
              isAdminHold
                ? 'Durdurma süresi bitiş tarihine eklenerek yerleşim yeniden yayına alınır.'
                : 'Bu yerleşim operatör kararıyla durdurulmadı. Sebep ortadan kalktığında kendiliğinden yayına döner.'
            }
          >
            {isAdminHold ? (
              <form action={resumeShowcasePlacementAction}>
                <input type="hidden" name="placementId" value={placementId} />
                <button className="btn btn-primary" type="submit">
                  Yerleşimi sürdür
                </button>
              </form>
            ) : (
              <p className="muted">
                {placement.suspendReason ? SHOWCASE_SUSPEND_REASON_LABELS[placement.suspendReason] : ''}
              </p>
            )}
          </SectionCard>
        ) : null}

        {isLive && canCancel ? (
          <SectionCard
            title="Yerleşimi iptal et"
            subtitle="Yerleşim sonlanır ve yayından kalkar. Para iadesi otomatik yapılmaz: ilgili satın alma manuel inceleme için işaretlenir ve kararı bir insan verir."
          >
            <form action={cancelShowcasePlacementAction} className="form-grid" data-testid="placement-cancel-form">
              <input type="hidden" name="placementId" value={placementId} />
              <label className="form-grid-wide">
                <span>Not</span>
                <textarea name="note" maxLength={500} placeholder="İptal gerekçesi" />
              </label>
              <div className="form-actions form-grid-wide">
                <ConfirmDialog
                  triggerLabel="Yerleşimi iptal et"
                  triggerClassName="btn btn-destructive"
                  title="Yerleşim iptal edilsin mi?"
                  consequence={CANCEL_CONSEQUENCE}
                  confirmLabel="Evet, kalıcı olarak iptal et"
                  testId="placement-cancel"
                />
              </div>
            </form>
          </SectionCard>
        ) : null}
      </div>
    </main>
  );
}

const SUSPENSION_COLUMNS: DataColumn[] = [
  { key: 'reason', label: 'Sebep' },
  { key: 'clock', label: 'Süre durdu' },
  { key: 'startedAt', label: 'Başlangıç' },
  { key: 'endedAt', label: 'Bitiş' },
  { key: 'endAt', label: 'Bitiş tarihi' },
  { key: 'actor', label: 'Operatör' },
];

const VERSION_CHANGE_COLUMNS: DataColumn[] = [
  { key: 'createdAt', label: 'Tarih' },
  { key: 'trigger', label: 'Sebep' },
  { key: 'version', label: 'Sürüm' },
];

/**
 * What `AdminShowcasePlacementsService.cancel` does, in the order it does it.
 * The last line is the audit record: the operator and the note are written to
 * `ShowcasePlacementCancellation` in the same transaction (API-HARDENING-001).
 */
const CANCEL_CONSEQUENCE = (
  <ul>
    <li>
      Yerleşim hemen “İptal edildi” olur ve bütün vitrin raflarından kalkar. Açık bir durdurma varsa o da kapanır.
    </li>
    <li>
      <strong>Geri alınamaz:</strong> iptal edilen yerleşim yeniden yayına alınamaz, kalan günler geri verilmez.
    </li>
    <li>
      <strong>Para iadesi yapılmaz.</strong> İlgili paket satın alması manuel inceleme için işaretlenir ve notunuz
      satın almanın yönetici notuna yazılır (satın alma daha önce işaretlenmişse not eklenmez).
    </li>
    <li>Hizmet verene e-posta gitmez. Kart, onaylı sürümü ve bu yerleşimden gelmiş talepler değişmez.</li>
    <li>İptal zamanı, iptal eden kişi ve notunuz yerleşimin kalıcı kaydına yazılır; bu kayıt sonradan değiştirilemez.</li>
  </ul>
);
