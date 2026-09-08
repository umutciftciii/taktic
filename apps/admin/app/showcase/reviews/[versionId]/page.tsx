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
import { PageHeader } from '../../../../components/page-header';
import { SectionCard } from '../../../../components/section-card';
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
 * Nothing here edits the card. An operator approves a business's words or refuses
 * them with a reason; a route that let them fix a typo would make the review row
 * a record of somebody approving their own text, and would put words in a
 * business's mouth about its own price.
 */
export default async function ShowcaseReviewPage({
  params,
  searchParams,
}: ShowcaseReviewPageProps) {
  await requireAdmin();
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

  return (
    <>
      <PageHeader
        title={version.title}
        subtitle={`${version.provider.businessName} · ${card.category.name} · sürüm ${version.versionNumber}`}
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Vitrin İncelemeleri', href: '/showcase/reviews' },
          { label: `Sürüm ${version.versionNumber}` },
        ]}
        actions={
          <span className="inline-actions">
            <span className={showcaseReviewBadgeClass(version.reviewStatus)}>
              {SHOWCASE_VERSION_REVIEW_LABELS[version.reviewStatus]}
            </span>
            <span className={showcaseStatusBadgeClass(card.status)}>
              Kart: {SHOWCASE_CARD_STATUS_LABELS[card.status]}
            </span>
          </span>
        }
      />

      {error ? (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      ) : null}
      {approved ? (
        <div className="notice notice-success" role="status">
          Sürüm onaylandı ve kartın yayına hazır sürümü oldu.
        </div>
      ) : null}
      {rejected ? (
        <div className="notice notice-success" role="status">
          Sürüm reddedildi. Gerekçe hizmet verene iletildi.
        </div>
      ) : null}

      <SectionCard title="İşletme">
        <dl className="meta-row">
          <div>
            <dt>İşletme</dt>
            <dd>
              <Link href={`/providers/${version.provider.id}`}>
                {version.provider.businessName}
              </Link>
            </dd>
          </div>
          <div>
            <dt>Yetkili</dt>
            <dd>{version.provider.contactName}</dd>
          </div>
          <div>
            <dt>Merkez</dt>
            <dd>
              {version.provider.district}, {version.provider.city}
            </dd>
          </div>
          <div>
            <dt>Kart türü</dt>
            <dd>{SHOWCASE_CARD_KIND_LABELS[version.kind]}</dd>
          </div>
        </dl>

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
          <dl className="meta-row">
            <div>
              <dt>Tarih</dt>
              <dd>{formatDateTime(version.autoPublish.createdAt)}</dd>
            </div>
            <div>
              <dt>Çıkarılan bölge anahtarları</dt>
              <dd>{version.autoPublish.removedAreaKeys.join(', ')}</dd>
            </div>
          </dl>
        </SectionCard>
      ) : null}

      {version.review ? (
        <SectionCard title="Verilmiş karar">
          <dl className="meta-row">
            <div>
              <dt>Karar</dt>
              <dd>{SHOWCASE_VERSION_REVIEW_LABELS[version.review.decision]}</dd>
            </div>
            <div>
              <dt>Karar veren</dt>
              <dd>
                {version.review.reviewedBy?.name ?? version.review.reviewedBy?.email ?? '-'}
              </dd>
            </div>
            <div>
              <dt>Tarih</dt>
              <dd>{formatDateTime(version.review.createdAt)}</dd>
            </div>
            {version.review.note ? (
              <div>
                <dt>Gerekçe</dt>
                <dd>{version.review.note}</dd>
              </div>
            ) : null}
          </dl>
        </SectionCard>
      ) : null}

      {isPending ? (
        <SectionCard
          title="Karar"
          subtitle="Onay bu sürümü kartın yayına hazır sürümü yapar. Ret, hizmet verenin okuyacağı bir gerekçe ister."
        >
          <form action={approveShowcaseVersionAction} className="inline-actions">
            <input type="hidden" name="versionId" value={version.id} />
            <button className="btn btn-primary btn-sm" type="submit">
              Onayla
            </button>
          </form>

          <form action={rejectShowcaseVersionAction} style={{ marginTop: 16 }}>
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
              <button className="btn btn-secondary btn-sm" type="submit">
                Reddet
              </button>
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
    </>
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
