import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  adminPermissionLabel,
  formatDateTime,
  formatPrice,
  statusLabel,
  type AdminAuditEntry,
  type AdminAuditPage,
  type AdminPermission,
  type AuditChange,
  type AuditRef,
  type AuditValue,
} from '../lib/api';
import { buildHref, type QueryParams } from '../lib/list-query';
import { pageSummary, pageWindow } from '../lib/pagination';
import { DataTable, type DataColumn } from './data-table';
import { EmptyState } from './empty-state';
import { SectionCard } from './section-card';

/**
 * ADMIN-ACTION-AUDIT-001 — one "Neler oldu" for every audited admin record.
 *
 * It draws an `AdminAuditPage` exactly as the API returned it: the API's order
 * (newest first, ties by id), the API's actor, the API's old and new values.
 * Nothing is derived from a record's own timestamps and nothing is filled in:
 * an actor the row does not name reads "Bilinmiyor", an actor whose name is
 * empty is shown by id, and a value that was empty reads "—".
 */

const COLUMNS: DataColumn[] = [
  { key: 'when', label: 'Zaman' },
  { key: 'what', label: 'Yapılan iş' },
  { key: 'who', label: 'Yapan' },
];

/** The label of each audited field, per domain where the same name means different things. */
const FIELD_LABELS: Record<string, string> = {
  name: 'Ad',
  slug: 'Kısa ad',
  kind: 'Tip',
  parent: 'Üst kategori',
  status: 'Durum',
  offerCreditCost: 'Teklif kredisi',
  unlimitedPackageEligible: 'Limitsiz pakete uygun',
  providerEnrollmentOpen: 'Hizmet veren seçimine açık',
  description: 'Açıklama',
  sortOrder: 'Sıra',
  iconKey: 'İkon',
  imageUrl: 'Görsel',
  coverImageUrl: 'Kapak görseli',
  type: 'Paket tipi',
  priceAmount: 'Fiyat',
  currency: 'Para birimi',
  creditAmount: 'Kredi',
  quotaCredits: 'Kota',
  periodDays: 'Süre (gün)',
  dailyOfferLimit: 'Günlük teklif sınırı',
  scopeCategories: 'Kategori kapsamı',
  isActive: 'Durum',
  durationDays: 'Süre (gün)',
  allowedCardKind: 'Kart tipi',
  maxAreas: 'En çok bölge',
  requiresAdminApproval: 'Yönetici onayı',
  activationWindowDays: 'Aktivasyon süresi (gün)',
  legalName: 'Yasal unvan',
  supportEmail: 'Destek e-postası',
  postalAddress: 'Posta adresi',
};

const CATEGORY_STATUS: Record<string, string> = { DRAFT: 'Taslak', ACTIVE: 'Yayında', INACTIVE: 'Kapalı' };
const CATEGORY_KIND: Record<string, string> = { GROUP: 'Grup', LEAF: 'Hizmet', ROUTER: 'Yönlendirici' };
const PACKAGE_TYPE: Record<string, string> = {
  ONE_TIME_CREDITS: 'Tek seferlik kredi',
  MONTHLY_QUOTA: 'Aylık kota',
  CATEGORY_UNLIMITED: 'Kategori limitsiz',
};
const CARD_KIND: Record<string, string> = { SERVICE: 'Hizmet vitrini', PROMOTION: 'Genel tanıtım' };

export function auditFieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

function isRef(value: AuditValue): value is AuditRef {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refLabel(ref: AuditRef): string {
  return ref.name ?? `#${ref.id}`;
}

/** One stored value as an operator reads it. */
export function formatAuditValue(domain: AdminAuditEntry['domain'], field: string, value: AuditValue): string {
  if (value === null || value === '') return '—';
  if (Array.isArray(value)) {
    if (value.length === 0) return '—';
    return (value as (AuditRef | string)[]).map((item) => (typeof item === 'string' ? item : refLabel(item))).join(', ');
  }
  if (isRef(value)) return refLabel(value);
  if (typeof value === 'boolean') {
    if (field === 'isActive') return value ? 'Aktif' : 'Pasif';
    return value ? 'Evet' : 'Hayır';
  }
  if (typeof value === 'number') {
    if (field === 'priceAmount') return formatPrice(value);
    return value.toLocaleString('tr-TR');
  }
  if (field === 'status') {
    return domain === 'CATEGORY' ? (CATEGORY_STATUS[value] ?? value) : statusLabel(value);
  }
  if (field === 'kind') return CATEGORY_KIND[value] ?? value;
  if (field === 'type') return PACKAGE_TYPE[value] ?? value;
  if (field === 'allowedCardKind') return CARD_KIND[value] ?? value;
  return value;
}

/** Who did it: the stored name, else the address, else the id — and "Bilinmiyor" when no actor is recorded. */
export function auditActorLabel(actor: AdminAuditEntry['actor'] | undefined): ReactNode {
  if (!actor) return <span className="cell-muted">Bilinmiyor</span>;
  const primary = actor.name ?? actor.email ?? `Hesap #${actor.id}`;
  return (
    <span className="cell-stack">
      <span>{primary}</span>
      {actor.name && actor.email ? <span className="cell-muted">{actor.email}</span> : null}
    </span>
  );
}

function ChangeList({ entry, changes }: { entry: AdminAuditEntry; changes: AuditChange[] }) {
  if (changes.length === 0) return null;
  // A create has no "before": its fields are listed with their first value.
  const isCreate = entry.action === 'CREATED';
  return (
    <ul className="audit-changes" data-testid="audit-changes">
      {changes.map((change) => (
        <li key={change.field} data-field={change.field}>
          <span className="audit-change-field">{auditFieldLabel(change.field)}:</span>{' '}
          {isCreate ? (
            <span className="audit-change-to">{formatAuditValue(entry.domain, change.field, change.to)}</span>
          ) : (
            <>
              <span className="audit-change-from">{formatAuditValue(entry.domain, change.field, change.from)}</span>
              {' → '}
              <span className="audit-change-to">{formatAuditValue(entry.domain, change.field, change.to)}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

const ROLE_ACTIONS: Record<string, string> = {
  ROLE_CREATED: 'Rol oluşturuldu',
  ROLE_UPDATED: 'Rol bilgileri değiştirildi',
  ROLE_PERMISSIONS_REPLACED: 'İzinler değiştirildi',
  ROLE_DEACTIVATED: 'Rol pasifleştirildi',
  ROLE_REACTIVATED: 'Rol yeniden aktifleştirildi',
  ASSIGNMENT_GRANTED: 'Rol atandı',
  ASSIGNMENT_REVOKED: 'Rol geri alındı',
};

const ROLE_CHANGED_FIELDS: Record<string, string> = { name: 'ad', description: 'açıklama', isActive: 'durum' };

const CATALOG_ACTIONS: Record<string, string> = {
  CREATED: 'Oluşturuldu',
  UPDATED: 'Güncellendi',
  STATUS_CHANGED: 'Durumu değişti',
};

function permissionNames(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((permission) => {
      const label = adminPermissionLabel(permission as AdminPermission);
      return `${label.area} · ${label.action}`;
    })
    .join(', ');
}

/**
 * A role row says what its `summary` recorded, and nothing more: the names of
 * the fields an edit touched (not their values), the permissions added and
 * removed, the account an assignment was about.
 */
function roleNote(entry: AdminAuditEntry, perspective: 'role' | 'user'): ReactNode {
  const payload = entry.payload ?? {};
  const lines: ReactNode[] = [];
  if (entry.action === 'ASSIGNMENT_GRANTED' || entry.action === 'ASSIGNMENT_REVOKED') {
    if (perspective === 'role') {
      const user = entry.targetUser;
      lines.push(<span key="user">Hesap: {user ? (user.name ?? user.email ?? `#${user.id}`) : 'Bilinmiyor'}</span>);
    } else {
      const roleName = entry.target?.label ?? (typeof payload.key === 'string' ? payload.key : null);
      lines.push(<span key="role">Rol: {roleName ?? (entry.target ? `#${entry.target.id}` : 'Bilinmiyor')}</span>);
    }
  }
  if (entry.action === 'ROLE_CREATED') {
    const granted = permissionNames(payload.permissions);
    lines.push(<span key="perm">{granted ? `İzinler: ${granted}` : 'İzinsiz oluşturuldu'}</span>);
  }
  if (entry.action === 'ROLE_PERMISSIONS_REPLACED') {
    const added = permissionNames(payload.added);
    const removed = permissionNames(payload.removed);
    if (added) lines.push(<span key="added">Eklenen: {added}</span>);
    if (removed) lines.push(<span key="removed">Çıkarılan: {removed}</span>);
  }
  if (entry.action === 'ROLE_UPDATED' && Array.isArray(payload.changed)) {
    const names = payload.changed
      .filter((item): item is string => typeof item === 'string')
      .map((field) => ROLE_CHANGED_FIELDS[field] ?? field);
    if (names.length > 0) lines.push(<span key="changed">Değişen alan: {names.join(', ')} (eski değer kaydedilmez)</span>);
  }
  return lines.length > 0 ? <span className="cell-stack">{lines}</span> : null;
}

/** The "Yapılan iş" cell of one entry: a title and, under it, what changed. */
export function describeAuditEntry(
  entry: AdminAuditEntry,
  options: { perspective?: 'role' | 'user' } = {},
): { title: ReactNode; note: ReactNode } {
  switch (entry.domain) {
    case 'ADMIN_ROLE':
      return {
        title: ROLE_ACTIONS[entry.action] ?? entry.action,
        note: roleNote(entry, options.perspective ?? 'role'),
      };
    case 'STAFF_ACCOUNT':
    case 'CUSTOMER': {
      const title = entry.action === 'ACTIVATED' ? 'Hesap aktifleştirildi' : 'Hesap pasifleştirildi';
      return {
        title,
        note: (
          <span className="cell-stack">
            <ChangeList entry={entry} changes={entry.changes} />
            {entry.reason ? <span>Gerekçe: {entry.reason}</span> : null}
          </span>
        ),
      };
    }
    case 'PROVIDER': {
      const status = entry.changes.find((change) => change.field === 'status');
      return {
        title: status
          ? `Durum: ${formatAuditValue('PROVIDER', 'status', status.from)} → ${formatAuditValue('PROVIDER', 'status', status.to)}`
          : 'Durum değişti',
        note:
          entry.reason || entry.note ? (
            <span className="cell-stack">
              {entry.reason ? <span>Ret gerekçesi: {entry.reason}</span> : null}
              {entry.note ? <span>Moderasyon notu: {entry.note}</span> : null}
            </span>
          ) : null,
      };
    }
    case 'COMPANY_SETTINGS':
      return { title: 'Şirket bilgileri değişti', note: <ChangeList entry={entry} changes={entry.changes} /> };
    default:
      return {
        title: CATALOG_ACTIONS[entry.action] ?? entry.action,
        note: <ChangeList entry={entry} changes={entry.changes} />,
      };
  }
}

/** The pager under a timeline, on its own query parameter so it never moves another list on the page. */
function AuditPager({
  page,
  path,
  params,
  pageParam,
}: {
  page: AdminAuditPage;
  path: string;
  params: QueryParams;
  pageParam: string;
}) {
  const current = pageWindow({ page: page.page, pageSize: page.pageSize, total: page.total, hasNextPage: page.hasNextPage });
  if (!current.hasPrevious && !current.hasNext) return null;
  const href = (target: number) => buildHref(path, params, { [pageParam]: target <= 1 ? undefined : target });
  return (
    <nav className="pagination audit-pagination" aria-label="Geçmiş sayfaları">
      <p className="pagination-summary">{pageSummary(current, 'kayıt')}</p>
      <div className="pagination-links">
        {current.hasPrevious ? (
          <Link className="btn btn-secondary btn-sm" href={href(current.page - 1)} rel="prev" data-testid="audit-previous">
            Önceki
          </Link>
        ) : null}
        {current.hasNext ? (
          <Link className="btn btn-secondary btn-sm is-next" href={href(current.page + 1)} rel="next" data-testid="audit-next">
            Sonraki
          </Link>
        ) : null}
      </div>
    </nav>
  );
}

export function AuditTimeline({
  page,
  title = 'Neler oldu',
  meta,
  empty = 'Henüz kayıtlı bir değişiklik yok.',
  footnote,
  testId,
  perspective,
  pager,
}: {
  page: AdminAuditPage;
  title?: ReactNode;
  meta?: ReactNode;
  empty?: ReactNode;
  footnote?: ReactNode;
  testId?: string;
  perspective?: 'role' | 'user';
  /** Where the timeline's own page links point; omitted, only the first page is shown. */
  pager?: { path: string; params: QueryParams; pageParam: string };
}) {
  return (
    <SectionCard
      title={title}
      actions={meta ? <span className="section-card-meta">{meta}</span> : undefined}
      padded={false}
      className="detail-tab-card"
      testId={testId}
    >
      {page.items.length === 0 ? (
        <EmptyState title={empty} />
      ) : (
        <DataTable caption={typeof title === 'string' ? title : 'Neler oldu'} columns={COLUMNS} minWidth={560}>
          {page.items.map((entry) => {
            const { title: what, note } = describeAuditEntry(entry, { perspective });
            return (
              <tr key={entry.id} data-testid="audit-row" data-action={entry.action}>
                <td className="cell-nowrap">
                  <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
                </td>
                <td>
                  <div className="cell-stack">
                    <strong className="cell-break">{what}</strong>
                    {note ? <span className="cell-muted cell-break">{note}</span> : null}
                  </div>
                </td>
                <td className="cell-break" data-testid="audit-actor">
                  {auditActorLabel(entry.actor)}
                </td>
              </tr>
            );
          })}
        </DataTable>
      )}
      {pager ? <AuditPager page={page} {...pager} /> : null}
      {footnote ? (
        <p className="detail-card-footnote" data-testid={testId ? `${testId}-footnote` : undefined}>
          {footnote}
        </p>
      ) : null}
    </SectionCard>
  );
}

/** What every audit card says once about the rows it does not have. */
export const AUDIT_SINCE_NOTE =
  'Kayıt, değişiklik geçmişinin tutulmaya başlandığı andan itibarendir; öncesindeki değişiklikler kaydedilmediği için burada görünmez.';
