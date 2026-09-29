import { serviceAreaLabel } from '@taktic/shared';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ApiError,
  apiFetch,
  formatDateTime,
  formatPrice,
  requireAdmin,
  showcaseReviewBadgeClass,
  showcaseStatusBadgeClass,
  SHOWCASE_CARD_KIND_LABELS,
  SHOWCASE_CARD_STATUS_LABELS,
  SHOWCASE_VERSION_REVIEW_LABELS,
  type ShowcaseCardVersion,
  type ShowcaseVersionDetail,
} from '../../../../lib/api';
import { ConfirmDialog } from '../../../../components/confirm-dialog';
import { DetailHeader } from '../../../../components/detail-header';
import { KeyValueList } from '../../../../components/key-value-list';
import { SectionCard } from '../../../../components/section-card';
import type { SummaryItem } from '../../../../components/summary-strip';
import { approveShowcaseVersionAction, rejectShowcaseVersionAction } from './actions';

type ShowcaseReviewPageProps = {
  params: Promise<{ versionId: string }>;
  searchParams: Promise<{ error?: string; approved?: string; rejected?: string }>;
};

/**
 * One vitrin card version, and the decision about it.
 *
 * The screen is arranged around what the decision actually is: a claim a
 * business is about to make in public, at a price it names, in places it says it
 * works. So the version is shown beside two things it has to be judged against —
 * the provider's own declared service areas, and the version currently live, if
 * there is one.
 *
 * That last comparison is the one an operator most needs and would otherwise
 * have to reconstruct. Approving version four of a card means replacing version
 * three, and "what changes if I say yes" is not answerable from the new text
 * alone.
 *
 * ADMIN-DESIGN-001 Faz 3C: no screen of its own in the design (`soon`), so it
 * sits on the shared detail template. Refusing asks first, in a dialog whose
 * text follows `rejectVersion` exactly — including the part that is easy to
 * get wrong: no mail goes out for a refusal, and for a card that is already
 * live the note does not reach the provider's panel either.
 *
 * Nothing here edits the card. An operator approves a business's words or refuses
 * them with a reason; a route that let them fix a typo would make the review row
 * a record of somebody approving their own text, and would put words in a
 * business's mouth about its own price.
 */
export default async function ShowcaseReviewPage({
  params,
  searchParams,
}: ShowcaseReviewPageProps) {
  const { can } = await requireAdmin('SHOWCASE_REVIEW_READ');
  const canDecide = can('SHOWCASE_REVIEW_DECIDE');
  const canOpenProvider = can('PROVIDERS_READ_DETAIL');
  const { versionId } = await params;
  const { error, approved, rejected } = await searchParams;

  let version: ShowcaseVersionDetail;
  try {
    version = await apiFetch<ShowcaseVersionDetail>(
      `/admin/showcase/versions/${encodeURIComponent(versionId)}`,
    );
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) {
      notFound();
    }
    throw caught;
  }

  const card = version.card;
  const live = card.liveVersion;
  const isPending = version.reviewStatus === 'PENDING';
  const replaces = live && live.id !== version.id ? live : null;

  const facts: SummaryItem[] = [
    { label: 'Kart türü', value: SHOWCASE_CARD_KIND_LABELS[version.kind] },
    {
      label: 'İlan ettiği fiyat',
      value:
        version.listedServicePriceAmount === null
          ? 'Sabit fiyat yok'
          : formatPrice(version.listedServicePriceAmount, version.listedServiceCurrency),
      note: 'hizmet verenin kendi fiyatı',
    },
    { label: 'Bölge', value: `${version.areas.length} bölge` },
    {
      label: 'Yanıt taahhüdü',
      value: `${version.responseSlaUrgentHours} / ${version.responseSlaNormalHours} saat`,
      note: 'acil / normal',
    },
    { label: 'Gönderim', value: version.submittedAt ? formatDateTime(version.submittedAt) : '—' },
  ];

  return (
    <main className="showcase-review-detail-page">
      <DetailHeader
        back={{ href: '/showcase/reviews', label: 'Onay bekleyen kartlar' }}
        badges={
          <>
            <span className={showcaseReviewBadgeClass(version.reviewStatus)} data-testid="showcase-version-review-status">
              {SHOWCASE_VERSION_REVIEW_LABELS[version.reviewStatus]}
            </span>
            <span className={showcaseStatusBadgeClass(card.status)} data-testid="showcase-card-status">
              Kart: {SHOWCASE_CARD_STATUS_LABELS[card.status]}
            </span>
          </>
        }
        meta={`${version.versionNumber}. sürüm · ${card.category.name}`}
        title={version.title}
        subtitle={`${version.provider.businessName} · ${version.provider.district}, ${version.provider.city}`}
        facts={facts}
        factsLabel="Sürüm özeti"
        testId="showcase-review-header"
      />

      {error ? (
        <div className="notice notice-error detail-notice" role="alert">
          {error}
        </div>
      ) : null}
      {approved === 'first' ? (
        <div className="notice notice-success detail-notice" role="status">
          Sürüm onaylandı; kart vitrinde yayına girdi. Hizmet verene e-posta gönderildi.
        </div>
      ) : null}
      {approved === 'revision' ? (
        <div className="notice notice-success detail-notice" role="status">
          Sürüm onaylandı ve yayındaki metin güncellendi. Hizmet verene e-posta gönderildi.
        </div>
      ) : null}
      {rejected ? (
        <div className="notice notice-success detail-notice" role="status" data-testid="showcase-rejected-notice">
          {card.liveVersion
            ? 'Sürüm reddedildi. Yayındaki sürüm yayında kalır. Gerekçe hizmet verenin panelinde kart sayfasında görünür; hizmet verene notu içermeyen bir e-posta gönderildi.'
            : 'Sürüm reddedildi. Gerekçe hizmet verenin panelinde kartın durumunda görünür; e-posta gitmedi.'}
        </div>
      ) : null}

      <div className="detail-panel">
        <SectionCard title="İşletme">
          <KeyValueList
            items={[
              {
                label: 'İşletme',
                value: canOpenProvider ? (
                  <Link href={`/providers/${version.provider.id}`}>{version.provider.businessName}</Link>
                ) : (
                  version.provider.businessName
                ),
              },
              { label: 'Yetkili', value: version.provider.contactName },
              { label: 'Merkez', value: `${version.provider.district}, ${version.provider.city}` },
              { label: 'Kart türü', value: SHOWCASE_CARD_KIND_LABELS[version.kind] },
            ]}
          />

          {/*
            The provider's own declared coverage, printed beside the card's claim.
            The API already refuses a card area outside it — this is here so the
            operator can see the relation rather than trust it.
          */}
          <h3 className="section-card-subtitle" style={{ marginTop: 16 }}>
            İşletmenin hizmet bölgeleri
          </h3>
          <ul className="showcase-list">
            {version.provider.serviceAreas.map((area) => (
              <li key={`${area.city}|${area.district ?? ''}|${area.neighborhood ?? ''}`}>
                {serviceAreaLabel(area)}
              </li>
            ))}
          </ul>
        </SectionCard>

        {card.liveVersion === null ? (
          <SectionCard title="Yayın hakkı">
            {version.entitlement ? (
              <p data-testid="review-entitlement">
                {version.entitlement.packageName} · {version.entitlement.durationDays} gün yayın ·{' '}
                {version.entitlement.pausedForReview
                  ? 'inceleme süresince geçerliliği durduruldu'
                  : `${formatDateTime(version.entitlement.expiresAt)} tarihine kadar geçerli`}
              </p>
            ) : (
              <div className="notice notice-error" role="alert" data-testid="review-entitlement-missing">
                Bu kartın geçerli bir yayın hakkı yok. Sağlayıcı vitrin paketi almadan kart
                onaylanıp yayına alınamaz.
              </div>
            )}
          </SectionCard>
        ) : null}

        <div className="showcase-compare">
          <SectionCard
            title="İncelenen sürüm"
            subtitle={
              version.submittedAt
                ? `Gönderim: ${formatDateTime(version.submittedAt)}`
                : 'Gönderim kaydı yok'
            }
          >
            <VersionBody version={version} />
          </SectionCard>

          {replaces ? (
            <SectionCard
              title={`Yerini alacağı sürüm (${replaces.versionNumber})`}
              subtitle="Onaylarsanız müşteriye gösterilecek metin bu sürümden yenisine geçer."
            >
              <VersionBody version={replaces} />
            </SectionCard>
          ) : (
            <SectionCard
              title="Yerini alacağı sürüm yok"
              subtitle="Bu kartın daha önce onaylanmış bir sürümü bulunmuyor."
            >
              <p className="cell-muted">
                Onaylarsanız bu, kartın ilk yayına hazır sürümü olur.
              </p>
            </SectionCard>
          )}
        </div>

        {version.autoPublish ? (
          <SectionCard
            title="Bu sürüm operatör kararı olmadan yayına alındı"
            subtitle="Yalnızca bölge daraltan bir değişiklik; sistem olayı olarak kaydedildi."
          >
            <KeyValueList
              items={[
                { label: 'Tarih', value: formatDateTime(version.autoPublish.createdAt) },
                { label: 'Çıkarılan bölge anahtarları', value: version.autoPublish.removedAreaKeys.join(', ') },
              ]}
            />
          </SectionCard>
        ) : null}

        {version.review ? (
          <SectionCard title="Verilmiş karar">
            <KeyValueList
              items={[
                { label: 'Karar', value: SHOWCASE_VERSION_REVIEW_LABELS[version.review.decision] },
                {
                  label: 'Karar veren',
                  value: version.review.reviewedBy?.name ?? version.review.reviewedBy?.email ?? '-',
                },
                { label: 'Tarih', value: formatDateTime(version.review.createdAt) },
                ...(version.review.note ? [{ label: 'Gerekçe', value: version.review.note }] : []),
              ]}
            />
          </SectionCard>
        ) : null}

        {isPending && !canDecide ? null : isPending ? (
          <SectionCard
            title="Karar"
            subtitle="Onay bu sürümü kartın yayına hazır sürümü yapar ve hizmet verene e-posta gönderir. Ret, gerekçe ister ve onaydan önce ne olacağını sorar."
          >
            <form action={approveShowcaseVersionAction} className="inline-actions">
              <input type="hidden" name="versionId" value={version.id} />
              <button
                className="btn btn-primary btn-sm"
                type="submit"
                disabled={!isPending || (card.liveVersion === null && !version.entitlement?.valid)}
              >
                Onayla
              </button>
              {card.liveVersion === null && !version.entitlement?.valid ? (
                <span className="cell-muted">Geçerli bir yayın hakkı yok.</span>
              ) : null}
            </form>

            <form action={rejectShowcaseVersionAction} style={{ marginTop: 16 }} data-testid="showcase-reject-form">
              <input type="hidden" name="versionId" value={version.id} />
              <label className="form-row" htmlFor="showcase-reject-note">
                <span>Ret gerekçesi *</span>
                <textarea
                  id="showcase-reject-note"
                  name="note"
                  required
                  minLength={10}
                  maxLength={1000}
                  rows={4}
                  placeholder="Hizmet verenin düzeltebilmesi için neyin kabul edilmediğini yazın."
                />
              </label>
              <div className="inline-actions" style={{ marginTop: 12 }}>
                <ConfirmDialog
                  triggerLabel="Reddet"
                  triggerClassName="btn btn-secondary btn-sm"
                  title="Bu sürüm reddedilsin mi?"
                  consequence={
                    replaces || card.liveVersion ? (
                      <ul>
                        <li>
                          Bu sürüm “Reddedildi” olarak kapanır ve yeniden incelemeye alınamaz; hizmet veren yeni bir
                          sürüm gönderebilir.
                        </li>
                        <li>
                          <strong>
                            Yayındaki {card.liveVersion?.versionNumber ?? replaces?.versionNumber}. sürüm yayında
                            kalır;
                          </strong>{' '}
                          kart “Onaylı” kalır, yayın süresi ve raflar değişmez.
                        </li>
                        <li>
                          Gerekçe hizmet verenin panelinde kart sayfasında “İnceleme notu” olarak görünür; hizmet veren
                          yeni bir taslak açana ya da sonraki bir sürüm onaylanana kadar orada kalır.
                        </li>
                        <li>
                          Hizmet verene bir kez e-posta gider: değişikliğin onaylanmadığını ve notun panelde olduğunu
                          söyler. Notunuz e-postaya eklenmez.
                        </li>
                      </ul>
                    ) : (
                      <ul>
                        <li>
                          Kart “Reddedildi” durumuna geçer ve yayına girmez. Karar geri alınamaz; hizmet veren yeni bir
                          sürüm gönderebilir.
                        </li>
                        <li>
                          Kartın bir yayın hakkı varsa hak kartta kalır; incelemede geçen süre hakkın geçerliliğine geri
                          eklenir.
                        </li>
                        <li>
                          Gerekçe hizmet verenin panelinde kartın durumunda “İnceleme notu” olarak görünür. E-posta
                          gitmez.
                        </li>
                      </ul>
                    )
                  }
                  confirmLabel="Evet, sürümü reddet"
                  testId="showcase-reject"
                />
              </div>
            </form>
          </SectionCard>
        ) : (
          <SectionCard title="Karar">
            <p className="cell-muted">
              Bu sürüm inceleme bekleyen bir sürüm değil; üzerinde işlem yapılamaz.
            </p>
          </SectionCard>
        )}
      </div>
    </main>
  );
}

/** One version's content, in the order an operator reads it. */
function VersionBody({ version }: { version: ShowcaseCardVersion }) {
  return (
    <dl className="meta-row">
      <div>
        <dt>Başlık</dt>
        <dd>{version.title}</dd>
      </div>
      <div>
        <dt>Özet</dt>
        <dd>{version.summary}</dd>
      </div>
      <div>
        <dt>Hizmet bedeli</dt>
        <dd>
          {version.listedServicePriceAmount === null ? (
            <span className="cell-muted">Sabit fiyat yok (genel tanıtım)</span>
          ) : (
            <>
              {formatPrice(version.listedServicePriceAmount, version.listedServiceCurrency)}
              <div className="cell-muted">
                Hizmet verenin kendi fiyatı. TakTick tahsil etmez, taraf değildir.
              </div>
            </>
          )}
        </dd>
      </div>
      <div>
        <dt>Yanıt taahhüdü</dt>
        <dd>
          Acil: en geç {version.responseSlaUrgentHours} saat · Normal: en geç{' '}
          {version.responseSlaNormalHours} saat
        </dd>
      </div>
      <div>
        <dt>Dahil olanlar</dt>
        <dd>
          <ul className="showcase-list">
            {version.scopeIncluded.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </dd>
      </div>
      <div>
        <dt>Hariç olanlar</dt>
        <dd>
          <ul className="showcase-list">
            {version.scopeExcluded.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </dd>
      </div>
      <div>
        <dt>Kartın bölgeleri</dt>
        <dd>
          <ul className="showcase-list">
            {version.areas.map((area) => (
              <li key={area.areaKey}>{area.label}</li>
            ))}
          </ul>
        </dd>
      </div>
      <div>
        <dt>Görsel</dt>
        <dd>
          {version.imageUrl ? (
            <a href={version.imageUrl} target="_blank" rel="noreferrer noopener">
              {version.imageUrl}
            </a>
          ) : (
            <span className="cell-muted">Yok</span>
          )}
        </dd>
      </div>
      <div>
        <dt>Fiyat sorumluluk metni onayı</dt>
        <dd>
          {version.priceTermsAcceptedAt
            ? `${version.priceTermsVersion} · ${formatDateTime(version.priceTermsAcceptedAt)}`
            : 'Yok'}
        </dd>
      </div>
    </dl>
  );
}
