import Link from 'next/link';
import { formatDateTime } from '@taktic/shared';
import { DataTable, type DataColumn } from '../../components/data-table';
import { EmptyState } from '../../components/empty-state';
import { SectionCard } from '../../components/section-card';
import type { MatchReviewQueue } from '../../lib/match-rounds';
import { PROVIDER_INCIDENT_STATUS_LABELS, SERVICE_ISSUE_REASON_LABELS } from '../../lib/service-incidents';

const COLUMNS: DataColumn[] = [
  { key: 'no', label: 'Talep' },
  { key: 'round', label: 'Başarısız tur' },
  { key: 'failedAt', label: 'İncelemeye düştü' },
  { key: 'incident', label: 'Son aksaklık' },
  { key: 'excluded', label: 'Dışlanan', align: 'end' },
  { key: 'actions', label: 'Bağlantılar', srOnly: true },
];

/**
 * REL-002 Faz 5 — "İnceleme bekleyen eşleşmeler": the MATCH_REVIEW queue,
 * oldest failure first, from `GET /admin/service-requests/match-review`. Each
 * row links to what an operator needs to decide: the request's round
 * timeline, the last incident and the provider's reliability record (each
 * only with its own read permission).
 */
export function MatchReviewQueueCard({
  queue,
  canOpenIncidents,
  canOpenReliability,
}: {
  queue: MatchReviewQueue;
  canOpenIncidents: boolean;
  canOpenReliability: boolean;
}) {
  return (
    <SectionCard
      title="İnceleme bekleyen eşleşmeler"
      subtitle="Üç otomatik tur da hizmet aksaklığıyla bitti; en eski önce. Yeni tur, talebin “Eşleşme turları” sekmesinden açılır."
      testId="match-review-queue"
    >
      {queue.items.length === 0 ? (
        <EmptyState title="İnceleme bekleyen eşleşme yok." description="Üçüncü turu başarısız olan talepler burada listelenir." />
      ) : (
        <DataTable caption="İnceleme bekleyen eşleşmeler" columns={COLUMNS} minWidth={860} testId="match-review-table">
          {queue.items.map((item) => {
            const incident = item.currentRound.failureIncident;
            const ref = item.requestNumber ?? `#${item.id.slice(-8)}`;
            return (
              <tr key={item.id} data-testid="match-review-row" data-request-id={item.id}>
                <td>
                  <div className="cell-stack">
                    <code className="display-number">{ref}</code>
                    <span className="cell-muted">
                      {item.category.name} · {item.district}, {item.city}
                    </span>
                  </div>
                </td>
                <td>Tur {item.currentRound.roundNumber}</td>
                <td>{item.currentRound.failedAt ? formatDateTime(item.currentRound.failedAt) : '—'}</td>
                <td>
                  {incident ? (
                    <div className="cell-stack">
                      <span>
                        {incident.incidentNumber} · {SERVICE_ISSUE_REASON_LABELS[incident.reason] ?? incident.reason}
                      </span>
                      <span className="cell-muted">
                        {incident.provider.businessName} · {PROVIDER_INCIDENT_STATUS_LABELS[incident.status] ?? incident.status}
                      </span>
                    </div>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="is-num">{item.exclusionCount}</td>
                <td className="col-actions">
                  <div className="inline-actions">
                    <Link
                      className="btn btn-secondary btn-sm"
                      href={`/requests/${item.id}?tab=turlar`}
                      aria-label={`${ref} talebinin eşleşme turları`}
                    >
                      Turlar
                    </Link>
                    {incident && canOpenIncidents ? (
                      <Link
                        className="btn btn-ghost btn-sm"
                        href={`/service-incidents/${incident.id}`}
                        aria-label={`${incident.incidentNumber} aksaklık kaydı`}
                      >
                        Aksaklık
                      </Link>
                    ) : null}
                    {incident && canOpenReliability ? (
                      <Link
                        className="btn btn-ghost btn-sm"
                        href={`/providers/${incident.providerId}#guvenilirlik`}
                        aria-label={`${incident.provider.businessName} güvenilirlik kaydı`}
                      >
                        Güvenilirlik
                      </Link>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </DataTable>
      )}
    </SectionCard>
  );
}
