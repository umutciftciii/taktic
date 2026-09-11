import Link from 'next/link';
import {
  apiFetch,
  formatDateTime,
  requireAdmin,
  type ShowcasePriceTermsAcceptance,
} from '../../../lib/api';
import { EmptyState } from '../../../components/empty-state';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';

type PriceTermsPageProps = {
  searchParams: Promise<{ providerId?: string; cardId?: string; termsVersion?: string }>;
};

/**
 * Who agreed to which version of the price-responsibility text, and when.
 *
 * ## Read-only, and there is deliberately no button
 *
 * Not an omission to be filled in later. These rows are a record of consent,
 * and an operator who could add or remove one would be able to make the record
 * say what the platform wanted rather than what a business agreed to. There is
 * no API route behind such a button either, so the absence holds whatever a
 * future screen decides to render.
 *
 * ## Why every version is listed, not only the one in force
 *
 * The question asked here is historical. A provider whose run was sold under an
 * older version keeps that run to its own end date, and answering "what did
 * they agree to" for that placement means reading a superseded row. A list
 * narrowed to the current terms would hide exactly the history the table exists
 * to keep.
 *
 * ## What a row does not mean
 *
 * Not that the card is live, not that anything was bought, and not that a live
 * run is at risk when the version is superseded. Acceptance gates the *next*
 * purchase and nothing else — a placement already on the air runs to its end
 * under the terms it was sold under, which are snapshotted on the placement
 * itself rather than looked up from here.
 */
export default async function ShowcasePriceTermsPage({ searchParams }: PriceTermsPageProps) {
  await requireAdmin();

  const { providerId, cardId, termsVersion } = await searchParams;

  const query = new URLSearchParams();
  if (providerId) query.set('providerId', providerId);
  if (cardId) query.set('cardId', cardId);
  if (termsVersion) query.set('termsVersion', termsVersion);
  const suffix = query.toString() ? `?${query.toString()}` : '';

  const { acceptances } = await apiFetch<{ acceptances: ShowcasePriceTermsAcceptance[] }>(
    `/admin/showcase/price-terms-acceptances${suffix}`,
  );

  const versions = [...new Set(acceptances.map((row) => row.termsVersion))].sort();

  return (
    <>
      <PageHeader
        title="Vitrin Metin Onayları"
        subtitle="Hizmet bedeli sorumluluk metninin hangi sürümünün, hangi kart için, ne zaman onaylandığı."
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Vitrin Metin Onayları' }]}
      />

      <SectionCard
        title="Onaylar"
        subtitle={`${acceptances.length} onay listeleniyor. Kayıtlar yalnız eklenir: buradan bir onay oluşturulamaz, değiştirilemez ve silinemez. Onay yalnız yeni paket satın almayı açar; yayında olan bir vitrin süresi bundan etkilenmez.`}
        actions={
          <span className="inline-actions">
            <Link
              className={`btn btn-sm ${termsVersion ? 'btn-secondary' : 'btn-primary'}`}
              href="/showcase/price-terms"
            >
              Tümü
            </Link>
            {versions.map((candidate) => (
              <Link
                key={candidate}
                className={`btn btn-sm ${
                  termsVersion === candidate ? 'btn-primary' : 'btn-secondary'
                }`}
                href={`/showcase/price-terms?termsVersion=${encodeURIComponent(candidate)}`}
              >
                {candidate}
              </Link>
            ))}
          </span>
        }
        padded={false}
      >
        {acceptances.length === 0 ? (
          <EmptyState
            title="Onay yok"
            description="Bu filtreye uyan bir metin onayı bulunmuyor."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>İşletme</th>
                  <th>Kapsam</th>
                  <th>Kart</th>
                  <th>Sürüm</th>
                  <th>Onaylayan</th>
                  <th>Onay zamanı</th>
                  <th>Onaylanan metin</th>
                </tr>
              </thead>
              <tbody>
                {acceptances.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link href={`/providers/${row.provider.id}`}>
                        {row.provider.businessName}
                      </Link>
                    </td>
                    <td>{row.scope === 'PACKAGE' ? 'Paket' : 'Kart'}</td>
                    <td>
                      {row.card ? (
                        <>
                          <Link href={`/showcase/cards?cardId=${row.card.id}`}>
                            {row.card.id.slice(-6)}
                          </Link>
                          <div className="muted" style={{ fontSize: 12 }}>
                            {row.card.kind} · {row.card.status}
                          </div>
                        </>
                      ) : (
                        // A package-first acceptance names no card: the
                        // business agreed once, for every card it goes on to buy for.
                        '—'
                      )}
                    </td>
                    <td>{row.termsVersion}</td>
                    <td>
                      {row.acceptedByUser.name ?? '—'}
                      <div className="muted" style={{ fontSize: 12 }}>
                        {row.acceptedByUser.email ?? '—'}
                      </div>
                    </td>
                    <td>{formatDateTime(row.acceptedAt)}</td>
                    {/*
                      The sentence itself, from the row rather than from the
                      running application's constant. That is the whole reason
                      the text is snapshotted: an auditor asking what a business
                      agreed to in March must not have to check out an old
                      commit to find out.
                    */}
                    <td style={{ maxWidth: 420 }}>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {row.termsTextSnapshot}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </>
  );
}
