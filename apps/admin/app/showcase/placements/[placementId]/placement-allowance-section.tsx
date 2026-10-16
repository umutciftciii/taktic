import Link from 'next/link';
import {
  formatDateTime,
  OFFER_ALLOWANCE_VOID_REASON_LABELS,
  type ShowcaseOfferAllowance,
} from '../../../../lib/api';
import { ConfirmDialog } from '../../../../components/confirm-dialog';
import { DataTable, type DataColumn } from '../../../../components/data-table';
import { KeyValueList } from '../../../../components/key-value-list';
import { SectionCard } from '../../../../components/section-card';
import { NO_FREE_OFFERS_TEXT } from '../../../../lib/showcase-free-offers';
import { voidShowcaseAllowanceAction } from '../actions';
import {
  ALLOWANCE_VOID_NOTE_MAX_LENGTH,
  ALLOWANCE_VOID_NOTE_MIN_LENGTH,
  ALLOWANCE_VOID_REASON_CODES,
} from '../placement-cancel';

const ALLOWANCE_USAGE_COLUMNS: DataColumn[] = [
  { key: 'ordinal', label: 'Hak' },
  { key: 'offer', label: 'Teklif' },
  { key: 'listCost', label: 'Normal bedel' },
  { key: 'consumedAt', label: 'Kullanım' },
];

const ALLOWANCE_HISTORY_COLUMNS: DataColumn[] = [
  { key: 'when', label: 'Zaman' },
  { key: 'what', label: 'Olay' },
  { key: 'who', label: 'Yapan' },
];

/**
 * CAMPAIGN-ENTITLEMENT-001 — one run's free-offer allowance, for the operator.
 *
 * Counts, what is left and the subsidy (the category credits the free answers
 * would have cost) are the placement's own facts. Which offers spent the slots
 * comes only with OFFERS_READ — the API leaves `usages` out otherwise — and
 * never reads as a credit movement: no ledger row exists for a free answer.
 *
 * SHOWCASE-ALLOWANCE-004 — a VOID grant says so in words, with who, when, the
 * reason code, the internal note and how many slots it took, and the history
 * table lists the grant, every use and the void in order. A super admin
 * (SHOWCASE_ALLOWANCE_VOID) sees the void form while something is left to
 * void; its dialog shows the three figures it posts back as expectations.
 */
export function PlacementAllowanceSection({
  allowance,
  canOpenOffer,
  canVoid,
  packageFreeOfferCount,
  placementId,
}: {
  allowance: ShowcaseOfferAllowance | null;
  canOpenOffer: boolean;
  /** SHOWCASE_ALLOWANCE_VOID — a super admin's alone. */
  canVoid: boolean;
  /**
   * SHOWCASE-ALLOWANCE-001 — the package's free offer count as this run was
   * sold, never the package's current value.
   */
  packageFreeOfferCount: number;
  placementId: string;
}) {
  const voided = allowance?.status === 'VOID';

  return (
    <SectionCard
      title="Ücretsiz teklif hakkı"
      subtitle="Bu yayın dönemi, karttan gelen talepler için sınırlı sayıda ücretsiz teklif içerir. Hak harcandıktan sonra geri verilmez ve başka bir yerleşime geçmez; ücretsiz teklif için kredi hareketi yazılmaz."
      padded={false}
    >
      {allowance ? (
        <>
          {voided ? (
            <div className="notice notice-warning" style={{ margin: '12px 16px 0' }} role="status" data-testid="placement-allowance-voided">
              <strong>Ücretsiz teklif hakkı iptal edildi.</strong> Kalan {allowance.voidedRemaining} hak{' '}
              {allowance.voidedAt ? `${formatDateTime(allowance.voidedAt)} tarihinde ` : ''}iptal edildi. Kullanılmış
              haklar ve verilen teklifler değişmedi; bu karttan gelen taleplere verilecek teklifler kategori kredisiyle
              ücretlendirilir.
            </div>
          ) : null}
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
                {
                  label: 'Kalan',
                  value: (
                    <span data-testid="placement-allowance-remaining">
                      {voided ? `0 (${allowance.voidedRemaining} hak iptal edildi)` : String(allowance.remaining)}
                    </span>
                  ),
                },
                {
                  label: 'Ücretsiz yanıt bekleyen talep',
                  value: <span data-testid="placement-allowance-open-leads">{allowance.openLeads}</span>,
                },
                {
                  label: 'Paketten gelen',
                  value: (
                    <span data-testid="placement-allowance-package-count">
                      {packageFreeOfferCount} teklif (satın alma anındaki paket değeri)
                    </span>
                  ),
                },
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
                {
                  label: 'Durum',
                  value: (
                    <span
                      className={voided ? 'badge badge-bad' : 'badge badge-good'}
                      data-testid="placement-allowance-status"
                    >
                      {voided ? 'İptal edildi' : 'Geçerli'}
                    </span>
                  ),
                },
                ...(voided
                  ? [
                      {
                        label: 'İptal eden',
                        value: (
                          <span data-testid="placement-allowance-voided-by">
                            {allowance.voidedBy?.name ?? 'Adı olmayan personel hesabı'}
                          </span>
                        ),
                      },
                      {
                        label: 'İptal gerekçesi',
                        value: (
                          <span data-testid="placement-allowance-void-reason">
                            {allowance.voidReason ? OFFER_ALLOWANCE_VOID_REASON_LABELS[allowance.voidReason] : '—'}
                          </span>
                        ),
                      },
                      {
                        label: 'İç açıklama',
                        value: (
                          <span data-testid="placement-allowance-void-note">
                            {allowance.voidNote ?? '—'}
                            <div className="muted" style={{ fontSize: 12 }}>
                              Yalnız personel görür; hizmet verene gönderilen e-postada yer almaz.
                            </div>
                          </span>
                        ),
                      },
                    ]
                  : []),
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
          <AllowanceHistory allowance={allowance} />
          {canVoid && !voided && allowance.remaining > 0 ? (
            <AllowanceVoidForm allowance={allowance} placementId={placementId} />
          ) : null}
        </>
      ) : packageFreeOfferCount === 0 ? (
        <p className="muted" style={{ padding: '12px 16px', margin: 0 }} data-testid="placement-allowance-none">
          {NO_FREE_OFFERS_TEXT}: bu yayın dönemi 0 ücretsiz teklifle satıldı; hak tanımlanmadı ve karttan gelen
          taleplere verilen teklifler kategori kredi maliyetiyle ücretlendirilir.
        </p>
      ) : (
        <p className="muted" style={{ padding: '12px 16px', margin: 0 }} data-testid="placement-allowance-none">
          Bu yerleşim ücretsiz teklif hakkı sisteminden önce sona erdi; hak tanımlanmadı.
        </p>
      )}
    </SectionCard>
  );
}

/**
 * The grant's life in order: granted, each use the viewer may see (OFFERS_READ),
 * and the void. Drawn from the API's own timestamps; nothing is inferred.
 */
function AllowanceHistory({ allowance }: { allowance: ShowcaseOfferAllowance }) {
  type Entry = { key: string; at: string; what: string; who: string };
  const entries: Entry[] = [
    { key: 'granted', at: allowance.grantedAt, what: `${allowance.quotaTotal} ücretsiz teklif hakkı tanımlandı`, who: 'Sistem' },
    ...(allowance.usages ?? []).map((usage) => ({
      key: `usage-${usage.ordinal}`,
      at: usage.consumedAt,
      what: `Hak ${usage.ordinal} / ${allowance.quotaTotal} kullanıldı (${usage.offerNumber ?? 'teklif'})`,
      who: 'Hizmet veren',
    })),
    ...(allowance.status === 'VOID' && allowance.voidedAt
      ? [
          {
            key: 'voided',
            at: allowance.voidedAt,
            what: `Kalan ${allowance.voidedRemaining} hak iptal edildi${
              allowance.voidReason ? ` — ${OFFER_ALLOWANCE_VOID_REASON_LABELS[allowance.voidReason]}` : ''
            }`,
            who: allowance.voidedBy?.name ?? 'Adı olmayan personel hesabı',
          },
        ]
      : []),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  return (
    <DataTable
      caption="Ücretsiz teklif hakkı geçmişi"
      columns={ALLOWANCE_HISTORY_COLUMNS}
      minWidth={520}
      testId="placement-allowance-history"
    >
      {entries.map((entry) => (
        <tr key={entry.key} data-testid={`placement-allowance-history-${entry.key}`}>
          <td>{formatDateTime(entry.at)}</td>
          <td>{entry.what}</td>
          <td>{entry.who}</td>
        </tr>
      ))}
    </DataTable>
  );
}

/**
 * The super admin's void. The figures in the dialog are posted back unchanged
 * as the API's compare-and-set: had a slot been spent or a lead arrived since
 * this page was drawn, the API refuses and nothing is voided.
 */
function AllowanceVoidForm({ allowance, placementId }: { allowance: ShowcaseOfferAllowance; placementId: string }) {
  return (
    <form
      action={voidShowcaseAllowanceAction}
      className="form-grid"
      style={{ padding: '12px 16px' }}
      data-testid="placement-allowance-void-form"
    >
      <input type="hidden" name="placementId" value={placementId} />
      <input type="hidden" name="expectedQuotaTotal" value={allowance.quotaTotal} />
      <input type="hidden" name="expectedQuotaUsed" value={allowance.quotaUsed} />
      <input type="hidden" name="expectedOpenLeads" value={allowance.openLeads} />
      <label>
        <span>İptal gerekçesi *</span>
        <select name="reasonCode" required defaultValue="" data-testid="placement-allowance-void-reason-input">
          <option value="" disabled>
            Gerekçe seçin
          </option>
          {ALLOWANCE_VOID_REASON_CODES.map((code) => (
            <option key={code} value={code}>
              {OFFER_ALLOWANCE_VOID_REASON_LABELS[code]}
            </option>
          ))}
        </select>
      </label>
      <label className="form-grid-wide">
        <span>İç açıklama *</span>
        <textarea
          name="note"
          required
          minLength={ALLOWANCE_VOID_NOTE_MIN_LENGTH}
          maxLength={ALLOWANCE_VOID_NOTE_MAX_LENGTH}
          placeholder={`Neden iptal edildiğini yazın (en az ${ALLOWANCE_VOID_NOTE_MIN_LENGTH} karakter). Yalnız personel görür.`}
          data-testid="placement-allowance-void-note-input"
        />
      </label>
      <div className="form-actions form-grid-wide">
        <ConfirmDialog
          proof="showcase.allowance-void"
          triggerLabel="Kalan hakları iptal et"
          triggerClassName="btn btn-destructive"
          title="Ücretsiz teklif hakkı iptal edilsin mi?"
          consequence={
            <ul data-testid="placement-allowance-void-impact">
              <li>
                <strong>Kalan {allowance.remaining} ücretsiz teklif hakkı iptal edilir.</strong> Kısmi iptal yoktur;
                kalan hakların tamamı gider ve <strong>geri alınamaz</strong>.
              </li>
              <li>
                Kullanılmış {allowance.quotaUsed} / {allowance.quotaTotal} hak ve bu haklarla verilmiş teklifler
                değişmez.
              </li>
              <li>
                Ücretsiz yanıt bekleyen {allowance.openLeads} talep kapanmaz; bu taleplere bundan sonra verilecek teklifler
                kategori kredi maliyetiyle ücretlendirilir.
              </li>
              <li>
                <strong>Para iadesi, kredi hareketi veya yerleşim iptali yapılmaz.</strong> Yayın, kart ve satın alma
                olduğu gibi kalır.
              </li>
              <li>
                Hizmet verene bir kez e-posta gider; gerekçe kodu ve iç açıklama e-postada yer almaz.
              </li>
              <li>Bu sayılar onaydan önce değişirse işlem reddedilir ve güncel değerler gösterilir.</li>
            </ul>
          }
          confirmLabel="Evet, kalan hakları iptal et"
          testId="placement-allowance-void"
        />
      </div>
    </form>
  );
}
