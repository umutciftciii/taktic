import Link from 'next/link';
import { ApiError, apiFetch, formatDate, formatDateTime, requireAdmin } from '../../../lib/api';
import { buildHref, parsePage, type QueryParams } from '../../../lib/list-query';
import { formatCount } from '../../../lib/pagination';
import {
  SEO_NOT_FOUND_STATUS_LABELS,
  SEO_NOT_FOUND_STATUSES,
  SEO_REDIRECT_ORIGIN_LABELS,
  SEO_REDIRECT_ORIGINS,
  SEO_REDIRECT_TYPE_LABELS,
  SEO_ROUTE_FAMILY_LABELS,
  seoRefusalMessage,
  type SeoNotFoundStatus,
  type SeoNotFoundSuggestion,
  type SeoPage,
  type SeoRedirect,
  type SeoRedirectOrigin,
  type SeoSlugRow,
} from '../../../lib/seo';
import { CONFIRMATION_PROOF_REFUSAL_MESSAGE } from '../../../lib/confirmation-proof-keys';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import { DataTable, type DataColumn } from '../../../components/data-table';
import { EmptyState } from '../../../components/empty-state';
import { FilterBar, FilterField } from '../../../components/filter-bar';
import { PageHeader } from '../../../components/page-header';
import { Pagination } from '../../../components/pagination';
import { RouteDialog } from '../../../components/route-dialog';
import { Tabs } from '../../../components/tabs';
import { deactivateRedirectAction, rejectSuggestionAction } from '../actions';
import { RedirectForm } from './redirect-form';

/**
 * Yönlendirmeler (SEO-004 PR B), design `redirects` (paket 4
 * `42-yonlendirmeler`) and its window (`43-yonlendirme-ekle-penceresi`), with
 * a second tab for the 404 suggestions (`?sekme=oneriler`).
 *
 * Yönlendirmeler: every redirect `GET /admin/seo/redirects` returns — source,
 * target, 301/302, where it came from, whether it is active and served right
 * now, its reason, who wrote it and when. SEO_READ reads; SEO_REDIRECTS_WRITE
 * adds "Yeni yönlendirme ekle", "Düzenle" and "Kaldır". "Kaldır" is a soft
 * deactivate (the row stays, inactive) and asks first; there is no hard delete.
 * The design's "30 günde" and "Son kullanım" columns are not drawn: redirect
 * hits are not counted.
 *
 * Öneriler: the public 404s the API aggregated (no visitor data), each with its
 * deterministic candidate when there is one. Nothing becomes a redirect on its
 * own: "Onayla" opens a window where the operator picks the target, and both
 * approving and rejecting ask first.
 */

const PATH = '/seo/redirects';
const PAGE_SIZE = 25;

const SCREEN_INFO =
  'Eski adreslerin yeni adreslere yönlendirilmesi. 301 (kalıcı): adres temelli değişti, arama sıralaması yeni adrese taşınır. 302 (geçici): eski adres geri dönecek, sıralama taşınmaz. Gideceği adres her zaman sitenin yayındaki bir sayfasıdır; zincir (A→B→C) ve döngü kabul edilmez. Bir kategorinin adresi değişince oluşan yönlendirme otomatiktir ve 301 kalır. Kaldırılan yönlendirme silinmez, pasif olarak kayıtta kalır. 404 önerileri yalnız bir yöneticinin onayıyla yönlendirmeye dönüşür.';

const REDIRECT_COLUMNS: DataColumn[] = [
  { key: 'source', label: 'Eski adres' },
  { key: 'target', label: 'Gittiği yer' },
  { key: 'type', label: 'Tür' },
  { key: 'status', label: 'Durum' },
  { key: 'reason', label: 'Sebep' },
  { key: 'when', label: 'Kayıt' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

const SUGGESTION_COLUMNS: DataColumn[] = [
  { key: 'path', label: 'Adres' },
  { key: 'family', label: 'Sayfa türü' },
  { key: 'count', label: 'Görülme', align: 'end' },
  { key: 'first', label: 'İlk görülme' },
  { key: 'last', label: 'Son görülme' },
  { key: 'candidate', label: 'Önerilen hedef' },
  { key: 'status', label: 'Durum' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

const OK_MESSAGES: Record<string, string> = {
  eklendi: 'Yönlendirme eklendi ve hemen etkin.',
  guncellendi: 'Yönlendirme güncellendi.',
  kaldirildi: 'Yönlendirme kaldırıldı; pasif olarak kayıtta duruyor.',
  onaylandi: 'Öneri onaylandı; yönlendirme oluşturuldu.',
  reddedildi: 'Öneri reddedildi.',
};

type RedirectsPageProps = {
  searchParams: Promise<{
    sekme?: string;
    durum?: string;
    origin?: string;
    q?: string;
    status?: string;
    page?: string;
    yonlendirme?: string;
    oneri?: string;
    ok?: string;
    hata?: string;
  }>;
};

export default async function SeoRedirectsPage({ searchParams }: RedirectsPageProps) {
  const { can } = await requireAdmin('SEO_READ');
  const canWrite = can('SEO_REDIRECTS_WRITE');
  const raw = await searchParams;
  const tab = raw.sekme === 'oneriler' ? 'oneriler' : '';
  const page = parsePage(raw.page);

  const okText = raw.ok ? (OK_MESSAGES[raw.ok] ?? null) : null;
  const errorText = raw.hata
    ? raw.hata === 'CONFIRMATION_REQUIRED'
      ? CONFIRMATION_PROOF_REFUSAL_MESSAGE
      : seoRefusalMessage({ code: raw.hata }, raw.hata === 'CONFLICT' ? 409 : undefined)
    : null;

  // One panel per tab, read before the page renders: only the open tab's data.
  const panel =
    tab === 'oneriler'
      ? await SuggestionsPanel({ raw, page, canWrite })
      : await RedirectsPanel({ raw, page, canWrite });

  const tabs = [
    { key: '', label: 'Yönlendirmeler', testId: 'seo-tab-redirects' },
    { key: 'oneriler', label: '404 önerileri', testId: 'seo-tab-suggestions' },
  ];

  return (
    <main className="seo-page" data-testid="seo-redirects">
      <PageHeader
        title="Yönlendirmeler"
        subtitle={
          tab === 'oneriler'
            ? 'Bulunamayan (404) herkese açık adresler; yalnız onaylanınca yönlendirmeye dönüşür'
            : 'Eski adreslerden sitenin yayındaki sayfalarına kalıcı (301) ve geçici (302) yönlendirmeler'
        }
        info={SCREEN_INFO}
        actions={
          canWrite && tab === '' ? (
            <Link className="btn btn-primary" href={`${PATH}?yonlendirme=yeni`} scroll={false} data-testid="seo-redirect-new">
              Yeni yönlendirme ekle
            </Link>
          ) : null
        }
      />

      {okText ? (
        <div className="notice notice-success detail-notice" role="status" data-testid="seo-redirects-ok">
          {okText}
        </div>
      ) : null}
      {errorText ? (
        <div className="notice notice-error detail-notice" role="alert" data-testid="seo-redirects-error">
          {errorText}
        </div>
      ) : null}

      <Tabs label="Yönlendirme sekmeleri" items={tabs} active={tab} path={PATH} param="sekme" testId="seo-redirect-tabs" />

      {panel}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Yönlendirmeler
// ---------------------------------------------------------------------------

async function RedirectsPanel({
  raw,
  page,
  canWrite,
}: {
  raw: Awaited<RedirectsPageProps['searchParams']>;
  page: number;
  canWrite: boolean;
}) {
  // Etkin by default — the design's "Aktif yönlendirmeler"; the removed ones a
  // click away, never mixed in unasked.
  const durum = raw.durum === 'pasif' || raw.durum === 'tumu' ? raw.durum : '';
  const origin = (SEO_REDIRECT_ORIGINS as readonly string[]).includes(raw.origin ?? '') ? (raw.origin as SeoRedirectOrigin) : '';
  const q = (raw.q ?? '').trim().slice(0, 200);
  const filterParams: QueryParams = { durum, origin, q };
  const apiQuery = {
    active: durum === 'tumu' ? undefined : durum === 'pasif' ? 'false' : 'true',
    origin,
    q,
    page,
    pageSize: PAGE_SIZE,
  };
  const result = await apiFetch<SeoPage<SeoRedirect>>(`/admin/seo/redirects${buildHref('', apiQuery)}`);
  const hasFilters = Boolean(durum || origin || q);
  const backHref = buildHref(PATH, { ...filterParams, page: page > 1 ? page : undefined });

  const openKey = canWrite ? (raw.yonlendirme ?? '').trim() : '';
  const isNew = openKey === 'yeni';
  const editing = openKey && !isNew ? await readRedirect(openKey) : null;
  const targets = isNew || editing ? await liveTargets() : [];

  return (
    <>
      <FilterBar
        key={buildHref(PATH, filterParams)}
        action={PATH}
        clearHref={hasFilters ? PATH : null}
        label="Yönlendirme filtreleri"
        testId="seo-redirect-filters"
      >
        <FilterField label="Ara" htmlFor="seo-redirect-q" wide>
          <input id="seo-redirect-q" name="q" type="search" defaultValue={q} maxLength={200} placeholder="Eski veya yeni adres" />
        </FilterField>
        <FilterField label="Durum" htmlFor="seo-redirect-durum">
          <select id="seo-redirect-durum" name="durum" defaultValue={durum}>
            <option value="">Etkin</option>
            <option value="pasif">Kaldırılmış</option>
            <option value="tumu">Tümü</option>
          </select>
        </FilterField>
        <FilterField label="Kaynak" htmlFor="seo-redirect-origin">
          <select id="seo-redirect-origin" name="origin" defaultValue={origin}>
            <option value="">Tümü</option>
            {SEO_REDIRECT_ORIGINS.map((value) => (
              <option key={value} value={value}>
                {SEO_REDIRECT_ORIGIN_LABELS[value]}
              </option>
            ))}
          </select>
        </FilterField>
      </FilterBar>

      <div className="data-list-card">
        {result.items.length === 0 ? (
          <EmptyState
            title={hasFilters ? 'Filtreye uyan yönlendirme yok' : 'Etkin yönlendirme yok'}
            description={
              hasFilters
                ? 'Filtreleri değiştirin veya temizleyin.'
                : 'Bir kategorinin adresi değiştiğinde veya bir 404 önerisi onaylandığında yönlendirmeler burada görünür.'
            }
          />
        ) : (
          <DataTable caption="Yönlendirmeler" columns={REDIRECT_COLUMNS} minWidth={1180} testId="seo-redirect-table">
            {result.items.map((row) => {
              const sourceId = `seo-redirect-source-${row.id}`;
              const type = SEO_REDIRECT_TYPE_LABELS[row.type];
              return (
                <tr key={row.id} data-testid="seo-redirect-row" data-redirect-id={row.id} data-source={row.sourcePath}>
                  <td>
                    <div className="cell-stack">
                      <code className="cell-break" id={sourceId}>
                        {row.sourcePath}
                      </code>
                      <span className="cell-muted">
                        {SEO_REDIRECT_ORIGIN_LABELS[row.origin] ?? row.origin}
                        {row.createdBy?.name ? ` · ${row.createdBy.name}` : ''}
                      </span>
                    </div>
                  </td>
                  <td>
                    <code className="cell-break" data-testid="seo-redirect-target-cell">
                      {row.targetPath}
                    </code>
                  </td>
                  <td>
                    <span
                      className={row.type === 'PERMANENT' ? 'badge badge-good' : 'badge badge-warn'}
                      data-testid="seo-redirect-type-badge"
                    >
                      {type?.badge ?? row.type}
                    </span>
                  </td>
                  <td>
                    <div className="cell-stack">
                      {row.active ? (
                        <span className="badge badge-good" data-testid="seo-redirect-state">
                          Etkin
                        </span>
                      ) : (
                        <span className="badge badge-bad" data-testid="seo-redirect-state">
                          Kaldırıldı
                        </span>
                      )}
                      {row.active && !row.served ? (
                        <span className="cell-muted" data-testid="seo-redirect-not-served">
                          Şu an uygulanmıyor: gideceği adres yayında değil veya eski adres yeniden yayında
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <span className="cell-break">{row.reason ?? <span className="cell-muted">—</span>}</span>
                  </td>
                  <td>
                    <div className="cell-stack">
                      <span>{formatDate(row.createdAt)}</span>
                      {row.active ? (
                        row.updatedBy ? (
                          <span className="cell-muted">
                            Güncelleme: {formatDate(row.updatedAt)} · {row.updatedBy.name ?? 'yönetici'}
                          </span>
                        ) : null
                      ) : row.deactivatedAt ? (
                        <span className="cell-muted">
                          Kaldırma: {formatDate(row.deactivatedAt)}
                          {row.deactivatedBy?.name ? ` · ${row.deactivatedBy.name}` : ''}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="col-actions">
                    {canWrite && row.active ? (
                      <div className="seo-row-actions">
                        <Link
                          className="btn btn-secondary btn-sm"
                          href={buildHref(PATH, { ...filterParams, page: page > 1 ? page : undefined, yonlendirme: row.id })}
                          scroll={false}
                          aria-describedby={sourceId}
                          data-testid="seo-redirect-edit"
                        >
                          Düzenle
                        </Link>
                        <form action={deactivateRedirectAction}>
                          <input type="hidden" name="redirectId" value={row.id} />
                          <input type="hidden" name="back" value={backHref} />
                          <ConfirmDialog
                            proof="seo.redirect-deactivate"
                            triggerLabel="Kaldır"
                            triggerClassName="btn btn-destructive btn-sm"
                            title="Yönlendirmeyi kaldır"
                            consequence={
                              <div data-testid="seo-redirect-deactivate-body">
                                <dl className="confirm-dialog-facts">
                                  <div>
                                    <dt>Eski adres</dt>
                                    <dd>
                                      <code>{row.sourcePath}</code>
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>Gittiği yer</dt>
                                    <dd>
                                      <code>{row.targetPath}</code>
                                    </dd>
                                  </div>
                                </dl>
                                <p>
                                  Eski adres artık yönlendirilmez ve <strong>bulunamadı (404)</strong> yanıtı verir.
                                  Kayıt silinmez, pasif olarak listede kalır.
                                </p>
                                {row.origin === 'SLUG_CHANGE' ? (
                                  <p>
                                    Bu yönlendirme bir kategorinin adres değişikliğinden doğdu; kaldırılırsa eski kategori
                                    bağlantıları ve arama motoru kayıtları sonuçsuz kalır.
                                  </p>
                                ) : null}
                              </div>
                            }
                            confirmLabel="Evet, kaldır"
                            testId="seo-redirect-deactivate"
                          />
                        </form>
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </DataTable>
        )}
        {result.total > 0 ? (
          <Pagination
            path={PATH}
            params={filterParams}
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
            hasNextPage={result.hasNextPage}
            noun="yönlendirme"
            summaryTestId="seo-redirect-count"
          />
        ) : null}
      </div>

      {isNew ? (
        <RouteDialog title="Yeni yönlendirme ekle" closeHref={backHref} testId="seo-redirect-dialog">
          <RedirectForm mode={{ kind: 'create' }} targets={targets} cancelHref={backHref} />
        </RouteDialog>
      ) : null}
      {openKey && !isNew && !editing ? (
        <div className="notice notice-error detail-notice" role="alert" data-testid="seo-redirect-missing">
          Bu bağlantının gösterdiği yönlendirme bulunamadı.
        </div>
      ) : null}
      {editing ? (
        <RouteDialog title="Yönlendirmeyi düzenle" closeHref={backHref} testId="seo-redirect-dialog">
          {editing.active ? (
            <RedirectForm
              mode={{
                kind: 'edit',
                redirectId: editing.id,
                sourcePath: editing.sourcePath,
                lockedType: editing.origin === 'SLUG_CHANGE',
              }}
              defaultTarget={editing.targetPath}
              defaultType={editing.type}
              defaultReason={editing.reason ?? ''}
              targets={targets}
              cancelHref={backHref}
            />
          ) : (
            <div className="notice notice-error" role="alert">
              Bu yönlendirme kaldırılmış; değiştirilemez.
            </div>
          )}
        </RouteDialog>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// 404 önerileri
// ---------------------------------------------------------------------------

async function SuggestionsPanel({
  raw,
  page,
  canWrite,
}: {
  raw: Awaited<RedirectsPageProps['searchParams']>;
  page: number;
  canWrite: boolean;
}) {
  const status = (SEO_NOT_FOUND_STATUSES as readonly string[]).includes(raw.status ?? '')
    ? (raw.status as SeoNotFoundStatus)
    : 'OPEN';
  const filterParams: QueryParams = { sekme: 'oneriler', status: status === 'OPEN' ? undefined : status };
  const result = await apiFetch<SeoPage<SeoNotFoundSuggestion>>(
    `/admin/seo/not-found${buildHref('', { status, page, pageSize: PAGE_SIZE })}`,
  );
  const backHref = buildHref(PATH, { ...filterParams, page: page > 1 ? page : undefined });

  const openId = canWrite && status === 'OPEN' ? (raw.oneri ?? '').trim() : '';
  const approving = openId ? await findOpenSuggestion(openId, result.items) : null;
  const targets = approving ? await liveTargets() : [];

  return (
    <>
      <FilterBar
        key={buildHref(PATH, filterParams)}
        action={PATH}
        clearHref={status !== 'OPEN' ? `${PATH}?sekme=oneriler` : null}
        preserve={{ sekme: 'oneriler' }}
        label="404 önerisi filtreleri"
        testId="seo-suggestion-filters"
      >
        <FilterField label="Durum" htmlFor="seo-suggestion-status">
          <select id="seo-suggestion-status" name="status" defaultValue={status}>
            {SEO_NOT_FOUND_STATUSES.map((value) => (
              <option key={value} value={value}>
                {SEO_NOT_FOUND_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </FilterField>
      </FilterBar>

      <div className="data-list-card">
        {result.items.length === 0 ? (
          <EmptyState
            title={status === 'OPEN' ? 'İnceleme bekleyen öneri yok' : 'Bu durumda öneri yok'}
            description={
              status === 'OPEN'
                ? 'Henüz inceleme bekleyen 404 önerisi yok. Kategori, işletme veya vitrin kartı adreslerinden biri bulunamadığında burada görünür.'
                : 'Filtreyi değiştirin.'
            }
          />
        ) : (
          <DataTable caption="404 önerileri" columns={SUGGESTION_COLUMNS} minWidth={1120} testId="seo-suggestion-table">
            {result.items.map((row) => {
              const pathId = `seo-suggestion-path-${row.id}`;
              return (
                <tr key={row.id} data-testid="seo-suggestion-row" data-suggestion-id={row.id} data-path={row.path}>
                  <td>
                    <code className="cell-break" id={pathId}>
                      {row.path}
                    </code>
                  </td>
                  <td>{SEO_ROUTE_FAMILY_LABELS[row.routeFamily] ?? row.routeFamily}</td>
                  <td className="is-num">
                    <div className="cell-stack">
                      <strong>{formatCount(row.occurrenceCount)}</strong>
                      <span className="cell-muted">{formatCount(row.seenDays)} farklı gün</span>
                    </div>
                  </td>
                  <td>{formatDateTime(row.firstSeenAt)}</td>
                  <td>{formatDateTime(row.lastSeenAt)}</td>
                  <td>
                    {row.candidateTargetPath ? (
                      <code className="cell-break">{row.candidateTargetPath}</code>
                    ) : (
                      <span className="cell-muted">Öneri yok — hedef elle seçilir</span>
                    )}
                  </td>
                  <td>
                    <div className="cell-stack">
                      <span
                        className={
                          row.status === 'OPEN' ? 'badge badge-warn' : row.status === 'APPROVED' ? 'badge badge-good' : 'badge badge-muted'
                        }
                      >
                        {SEO_NOT_FOUND_STATUS_LABELS[row.status] ?? row.status}
                      </span>
                      {row.decidedAt ? (
                        <span className="cell-muted">
                          {formatDate(row.decidedAt)}
                          {row.decidedBy?.name ? ` · ${row.decidedBy.name}` : ''}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="col-actions">
                    {canWrite && row.status === 'OPEN' ? (
                      <div className="seo-row-actions">
                        <Link
                          className="btn btn-secondary btn-sm"
                          href={buildHref(PATH, { ...filterParams, page: page > 1 ? page : undefined, oneri: row.id })}
                          scroll={false}
                          aria-describedby={pathId}
                          data-testid="seo-suggestion-approve"
                        >
                          Onayla
                        </Link>
                        <form action={rejectSuggestionAction}>
                          <input type="hidden" name="suggestionId" value={row.id} />
                          <ConfirmDialog
                            proof="seo.suggestion-reject"
                            triggerLabel="Reddet"
                            triggerClassName="btn btn-destructive btn-sm"
                            title="404 önerisini reddet"
                            consequence={
                              <div data-testid="seo-suggestion-reject-body">
                                <p>
                                  <code>{row.path}</code> için yönlendirme oluşturulmaz; adres bulunamadı (404) yanıtı
                                  vermeye devam eder ve öneri listeden çıkar.
                                </p>
                                <label className="seo-field">
                                  <span className="seo-field-label">
                                    Sebep <span className="cell-muted">— isteğe bağlı, kayıtta görünür</span>
                                  </span>
                                  <input name="reason" maxLength={500} data-testid="seo-suggestion-reject-reason" />
                                </label>
                              </div>
                            }
                            confirmLabel="Evet, reddet"
                            testId="seo-suggestion-reject"
                          />
                        </form>
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </DataTable>
        )}
        {result.total > 0 ? (
          <Pagination
            path={PATH}
            params={filterParams}
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
            hasNextPage={result.hasNextPage}
            noun="öneri"
            summaryTestId="seo-suggestion-count"
          />
        ) : null}
      </div>

      {openId && !approving ? (
        <div className="notice notice-error detail-notice" role="alert" data-testid="seo-suggestion-missing">
          Bu bağlantının gösterdiği öneri bulunamadı veya karar verilmiş.
        </div>
      ) : null}
      {approving ? (
        <RouteDialog title="404 önerisini onayla" closeHref={backHref} testId="seo-suggestion-dialog">
          <RedirectForm
            mode={{ kind: 'approve', suggestionId: approving.id, sourcePath: approving.path }}
            defaultTarget={approving.candidateTargetPath ?? ''}
            defaultType="PERMANENT"
            targets={targets}
            cancelHref={backHref}
          />
        </RouteDialog>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function readRedirect(id: string): Promise<SeoRedirect | null> {
  try {
    const { redirect } = await apiFetch<{ redirect: SeoRedirect }>(`/admin/seo/redirects/${encodeURIComponent(id)}`);
    return redirect;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) return null;
    throw error;
  }
}

/** An open suggestion, from the page in hand or — for a deep link — the open queue. */
async function findOpenSuggestion(id: string, inHand: SeoNotFoundSuggestion[]): Promise<SeoNotFoundSuggestion | null> {
  const found = inHand.find((row) => row.id === id && row.status === 'OPEN');
  if (found) return found;
  const { items } = await apiFetch<SeoPage<SeoNotFoundSuggestion>>('/admin/seo/not-found?status=OPEN&pageSize=100');
  return items.find((row) => row.id === id) ?? null;
}

/**
 * The target field's suggestions: the always-live pages and every public
 * category's canonical address, from the slug list. A business or a card
 * address can still be typed; the API decides whether it is live.
 */
async function liveTargets(): Promise<string[]> {
  const { items } = await apiFetch<SeoPage<SeoSlugRow>>('/admin/seo/slugs?pageSize=100');
  return ['/', '/categories', '/vitrin', ...items.filter((row) => row.publiclyReachable).map((row) => row.path)];
}
