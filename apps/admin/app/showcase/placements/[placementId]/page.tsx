import Link from 'next/link';
import {
  apiFetch,
  formatDateTime,
  formatPrice,
  requireAdmin,
  showcasePlacementBadgeClass,
  SHOWCASE_CARD_KIND_LABELS,
  SHOWCASE_PLACEMENT_STATUS_LABELS,
  SHOWCASE_SUSPEND_REASON_LABELS,
  type ShowcasePlacement,
} from '../../../../lib/api';
import { PageHeader } from '../../../../components/page-header';
import { SectionCard } from '../../../../components/section-card';
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
  await requireAdmin();

  const { placementId } = await params;
  const { error, suspended, resumed, cancelled } = await searchParams;
  const placement = await apiFetch<ShowcasePlacement>(
    `/admin/showcase/placements/${placementId}`,
  );

  const isAdminHold = placement.suspendReason === 'ADMIN_ACTION';
  const isLive =
    placement.status === 'ACTIVE' ||
    placement.status === 'PENDING_ACTIVATION' ||
    placement.status === 'SUSPENDED';

  return (
    <>
      <PageHeader
        title={placement.version.title}
        subtitle={`${SHOWCASE_CARD_KIND_LABELS[placement.kind]} · ${placement.category.name}`}
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Yayındaki Kartlar', href: '/showcase/placements' },
          { label: placement.version.title },
        ]}
      />

      {error ? (
        <div className="notice notice-error" role="alert">
          {ERRORS[error] ?? ERRORS.SHOWCASE_PLACEMENT_ACTION_FAILED}
        </div>
      ) : null}
      {suspended ? (
        <div className="notice" role="status">
          Yerleşim durduruldu ve yayından kaldırıldı. Süre işlemiyor; sürdürdüğünüzde durdurma
          süresi kadar uzatılacak.
        </div>
      ) : null}
      {resumed ? (
        <div className="notice" role="status">
          Yerleşim yeniden yayında. Durdurma süresi bitiş tarihine eklendi.
        </div>
      ) : null}
      {cancelled ? (
        <div className="notice notice-warning" role="status">
          Yerleşim iptal edildi. <strong>Para iadesi yapılmadı</strong> — ilgili satın alma
          manuel inceleme için işaretlendi.
        </div>
      ) : null}

      <SectionCard title="Yerleşim">
        <dl className="detail-grid">
          <div>
            <dt>Durum</dt>
            <dd>
              <span className={showcasePlacementBadgeClass(placement.status)}>
                {SHOWCASE_PLACEMENT_STATUS_LABELS[placement.status]}
              </span>
              {placement.suspendReason ? (
                <div className="muted" style={{ fontSize: 12 }}>
                  {SHOWCASE_SUSPEND_REASON_LABELS[placement.suspendReason]}
                </div>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>İşletme</dt>
            <dd>
              {placement.provider ? (
                <Link href={`/providers/${placement.provider.id}`}>
                  {placement.provider.businessName}
                </Link>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div>
            <dt>Paket</dt>
            <dd>
              {placement.packageName} · {placement.durationDays} gün
            </dd>
          </div>
          <div>
            <dt>Yayın bedeli</dt>
            {/*
              What TakTick charged for the listing. Never shown beside the
              card's own service price, which is the provider's money.
            */}
            <dd>{formatPrice(placement.priceAmount, placement.currency)}</dd>
          </div>
          <div>
            <dt>Başlangıç</dt>
            <dd>{formatDateTime(placement.startAt)}</dd>
          </div>
          <div>
            <dt>Bitiş</dt>
            <dd>
              {formatDateTime(placement.endAt)}
              {placement.extendedDays > 0 ? (
                <div className="muted" style={{ fontSize: 12 }}>
                  Durdurmalar nedeniyle {placement.extendedDays} gün eklendi
                </div>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Yayındaki sürüm</dt>
            <dd>
              <Link href={`/showcase/reviews/${placement.version.id}`}>
                v{placement.version.versionNumber}
              </Link>
            </dd>
          </div>
          <div>
            <dt>Gelen talep</dt>
            <dd>{placement.leadCount}</dd>
          </div>
          <div>
            <dt>Raflar</dt>
            <dd>
              <ul className="plain-list">
                {placement.areas.map((area) => (
                  <li key={area.id}>
                    {area.label}
                    {!area.active ? <span className="muted"> · yayında değil</span> : null}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        </dl>
      </SectionCard>

      {placement.suspensions && placement.suspensions.length > 0 ? (
        <SectionCard
          title="Durdurma geçmişi"
          subtitle="“Süre durdu” sütunu, durdurma açıldığı anda alınan bir kopyadır; kural sonradan değişse bile bu satırlar değişmez."
          padded={false}
        >
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Sebep</th>
                  <th>Süre durdu</th>
                  <th>Başlangıç</th>
                  <th>Bitiş</th>
                  <th>Bitiş tarihi</th>
                  <th>Operatör</th>
                </tr>
              </thead>
              <tbody>
                {placement.suspensions.map((suspension) => (
                  <tr key={suspension.id}>
                    <td>{SHOWCASE_SUSPEND_REASON_LABELS[suspension.reason]}</td>
                    <td>
                      <span
                        className={suspension.extendsClock ? 'badge badge-good' : 'badge badge-muted'}
                      >
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
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : null}

      {placement.versionChanges && placement.versionChanges.length > 0 ? (
        <SectionCard
          title="Sürüm değişiklikleri"
          subtitle="Yerleşim, kartın yayındaki sürümünü takip eder; kart sayfası ile ana sayfa farklı metin göstermez."
          padded={false}
        >
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Tarih</th>
                  <th>Sebep</th>
                  <th>Sürüm</th>
                </tr>
              </thead>
              <tbody>
                {placement.versionChanges.map((change) => (
                  <tr key={change.id}>
                    <td>{formatDateTime(change.createdAt)}</td>
                    <td>
                      {change.trigger === 'ADMIN_APPROVAL'
                        ? 'Operatör onayı'
                        : 'Sağlayıcı bölge daralttı'}
                    </td>
                    <td>
                      <Link href={`/showcase/reviews/${change.toVersionId}`}>Yeni sürüm</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : null}

      {placement.status === 'ACTIVE' ? (
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

      {placement.status === 'SUSPENDED' ? (
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
              {placement.suspendReason
                ? SHOWCASE_SUSPEND_REASON_LABELS[placement.suspendReason]
                : ''}
            </p>
          )}
        </SectionCard>
      ) : null}

      {isLive ? (
        <SectionCard
          title="Yerleşimi iptal et"
          subtitle="Yerleşim sonlanır ve yayından kalkar. Para iadesi otomatik yapılmaz: ilgili satın alma manuel inceleme için işaretlenir ve kararı bir insan verir."
        >
          <form action={cancelShowcasePlacementAction} className="form-grid">
            <input type="hidden" name="placementId" value={placementId} />
            <label className="form-grid-wide">
              <span>Not</span>
              <textarea name="note" maxLength={500} placeholder="İptal gerekçesi" />
            </label>
            <div className="form-actions form-grid-wide">
              <button className="btn btn-danger" type="submit">
                Yerleşimi iptal et
              </button>
            </div>
          </form>
        </SectionCard>
      ) : null}
    </>
  );
}
