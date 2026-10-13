import Link from 'next/link';
import { formatDateTime, type ShowcaseOfferAllowance } from '../../../../lib/api';
import { DataTable, type DataColumn } from '../../../../components/data-table';
import { KeyValueList } from '../../../../components/key-value-list';
import { SectionCard } from '../../../../components/section-card';

const ALLOWANCE_USAGE_COLUMNS: DataColumn[] = [
  { key: 'ordinal', label: 'Hak' },
  { key: 'offer', label: 'Teklif' },
  { key: 'listCost', label: 'Normal bedel' },
  { key: 'consumedAt', label: 'Kullanım' },
];

/**
 * CAMPAIGN-ENTITLEMENT-001 — one run's free-offer allowance, for the operator.
 *
 * Counts, what is left and the subsidy (the category credits the free answers
 * would have cost) are the placement's own facts. Which offers spent the slots
 * comes only with OFFERS_READ — the API leaves `usages` out otherwise — and
 * never reads as a credit movement: no ledger row exists for a free answer.
 */
export function PlacementAllowanceSection({
  allowance,
  canOpenOffer,
}: {
  allowance: ShowcaseOfferAllowance | null;
  canOpenOffer: boolean;
}) {
  return (
    <SectionCard
      title="Ücretsiz teklif hakkı"
      subtitle="Bu yayın dönemi, karttan gelen talepler için sınırlı sayıda ücretsiz teklif içerir. Hak harcandıktan sonra geri verilmez ve başka bir yerleşime geçmez; ücretsiz teklif için kredi hareketi yazılmaz."
      padded={false}
    >
      {allowance ? (
        <>
          <div style={{ padding: '12px 16px' }}>
            <KeyValueList
              items={[
                {
                  label: 'Kullanılan / toplam',
                  value: (
                    <span data-testid="placement-allowance-usage">
                      {allowance.quotaUsed} / {allowance.quotaTotal}
                    </span>
                  ),
                },
                { label: 'Kalan', value: String(allowance.remaining) },
                {
                  label: 'Sübvanse edilen kredi',
                  value: `${allowance.subsidyCredits} kredi (normal kategori bedeli)`,
                },
                ...(allowance.legacyFreeOffers > 0
                  ? [
                      {
                        label: 'Eski sınırsız dönem',
                        value: `${allowance.legacyFreeOffers} ücretsiz teklif geçişte sayıldı`,
                      },
                    ]
                  : []),
                { label: 'Durum', value: allowance.status === 'ACTIVE' ? 'Geçerli' : 'İptal edildi' },
              ]}
            />
          </div>
          {allowance.usages && allowance.usages.length > 0 ? (
            <DataTable
              caption="Ücretsiz teklif hakkı kullanımları"
              columns={ALLOWANCE_USAGE_COLUMNS}
              minWidth={560}
              testId="placement-allowance-usages"
            >
              {allowance.usages.map((usage) => (
                <tr key={usage.ordinal}>
                  <td>
                    {usage.ordinal} / {allowance.quotaTotal}
                  </td>
                  <td>
                    {canOpenOffer ? (
                      <Link href={`/offers/${usage.offerId}`}>{usage.offerNumber ?? 'Teklif'}</Link>
                    ) : (
                      (usage.offerNumber ?? 'Teklif')
                    )}
                  </td>
                  <td>{usage.listCreditCostSnapshot} kredi</td>
                  <td>{formatDateTime(usage.consumedAt)}</td>
                </tr>
              ))}
            </DataTable>
          ) : null}
        </>
      ) : (
        <p className="muted" style={{ padding: '12px 16px', margin: 0 }} data-testid="placement-allowance-none">
          Bu yerleşim ücretsiz teklif hakkı sisteminden önce sona erdi; hak tanımlanmadı.
        </p>
      )}
    </SectionCard>
  );
}
