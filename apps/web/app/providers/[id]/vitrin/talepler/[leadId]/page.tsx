import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  fetchOrNotFound,
  formatDateTime,
  formatPrice,
  getCurrentUser,
  type OfferCostPreview,
  SHOWCASE_LEAD_CLOSE_REASON_LABELS,
  SHOWCASE_LEAD_STATUS_LABELS,
  SHOWCASE_LEAD_URGENCY_LABELS,
  type ProviderProfile,
  type ShowcaseProviderLead,
} from '../../../../../../lib/api';
import { ProviderShell } from '../../../../provider-shell';
import { readCreditBalance } from '../../../../provider-data';
import { leadDeadlineLabel, leadIsAnswerable, showcaseLeadBadgeClass } from '../../showcase-lead-ui';
import { ReportDialog } from '../../../requests/[requestId]/report-dialog';
import { createShowcaseLeadOfferAction } from './actions';
import { OfferCostPanel } from './offer-cost-panel';
import { OfferPriceField } from '../../../../offer-price-field';
import { OfferScheduleFields, OfferScheduleNotice } from '../../../../offer-schedule-fields';
import { isOfferScheduleErrorCode } from '@taktic/shared';
import { NO_FREE_OFFERS_TEXT } from '../../../../../../lib/showcase-free-offers';

type LeadPageProps = {
  params: Promise<{ id: string; leadId: string }>;
  searchParams: Promise<{
    error?: string;
    offered?: string;
    reported?: string;
    reportError?: string;
  }>;
};

/**
 * One direct vitrin lead, and the offer form for it.
 *
 * ## The two things this screen says that no other provider screen does
 *
 * 1. **What this answer costs, before it is sent.** Each placement carries
 *    three free offers (CAMPAIGN-ENTITLEMENT-001); after them an answer costs
 *    the category's credits like any other offer. The API's own preview says
 *    which, next to the button, with the allowance left — and the form posts
 *    that figure back so a price that moved meanwhile is a 409, never a charge.
 * 2. **There is a deadline.** It is in the header, in the table and next to the
 *    form, because it is the thing the business is actually being measured on.
 *
 * ## What is deliberately not here
 *
 * The customer's telephone number and e-mail address. Contact opens through the
 * accepted-offer path — `ContactRevealEvent` — and a direct lead is not an
 * exception to that rule. The API does not send them, so this page could not
 * render them if it wanted to.
 */
export default async function ShowcaseLeadPage({ params, searchParams }: LeadPageProps) {
  const { id, leadId } = await params;
  const { error, offered, reported, reportError } = await searchParams;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/vitrin/talepler/${leadId}`);
  }

  const [provider, lead, creditBalance] = await Promise.all([
    fetchOrNotFound(() => apiFetch<ProviderProfile>(`/providers/${id}`)),
    fetchOrNotFound(() =>
      apiFetch<ShowcaseProviderLead>(`/providers/${id}/showcase/leads/${leadId}`),
    ),
    readCreditBalance(id),
  ]);

  const answerable = leadIsAnswerable(lead);
  const costPreview = answerable && !lead.respondedOfferId ? await readOfferCost(id, lead.request.id) : null;

  return (
    <ProviderShell
      user={user}
      providerId={id}
      businessName={provider.businessName}
      active="showcase-leads"
      creditBalance={creditBalance}
      status={provider.status}
    >
      <nav className="pdash-crumbs" aria-label="Breadcrumb">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/providers/${id}/vitrin/talepler`}>Vitrin talepleri</Link>
        <span aria-hidden="true">/</span>
        <span>{lead.request.requestNumber ?? 'Talep'}</span>
      </nav>

      <header className="pdash-page-head">
        <span className="kicker">
          {lead.card.title} · {SHOWCASE_LEAD_URGENCY_LABELS[lead.urgencyBucket]}
        </span>
        <h1 className="pdash-page-title">{lead.request.requestNumber ?? 'Vitrin talebi'}</h1>
        <p className="pdash-page-sub">
          {lead.request.category.name} · {lead.request.district}, {lead.request.city}
        </p>
        <span className={showcaseLeadBadgeClass(lead.status)}>
          {SHOWCASE_LEAD_STATUS_LABELS[lead.status]}
        </span>
      </header>

      {lead.request.matchEnded ? (
        <div className="pdash-notice" role="status" data-testid="lead-match-ended">
          Eşleşme sonlandı: müşteri bu talepteki eşleşme için hizmet aksaklığı bildirdi. Bu talep sizin için kapandı.
        </div>
      ) : null}

      {error && isOfferScheduleErrorCode(error) ? (
        <OfferScheduleNotice code={error} />
      ) : error === 'CREDIT_COST_CHANGED' ? (
        <div className="pdash-notice pdash-notice-error" role="alert" id="lead-offer-error" data-testid="lead-offer-cost-changed">
          Teklif gönderilmedi: bu teklifin maliyeti değişti (ücretsiz vitrin hakkınız başka bir teklifte
          kullanıldı). Güncel maliyet aşağıda yazıyor; kontrol edip yeniden gönderin. Bakiyenizden kredi
          düşülmedi.
        </div>
      ) : error === 'INSUFFICIENT_CREDIT' ? (
        <div className="pdash-notice pdash-notice-error" role="alert" id="lead-offer-error" data-testid="lead-offer-insufficient">
          Teklif gönderilmedi: kredi bakiyeniz bu teklif için yetersiz.{' '}
          <Link href={`/providers/${id}/credits`}>Kredi yükleyin</Link> ve tekrar deneyin.
        </div>
      ) : error ? (
        <div className="pdash-notice pdash-notice-error" role="alert">
          Teklif gönderilemedi. Bilgileri kontrol edip tekrar deneyin.
        </div>
      ) : null}
      {offered ? (
        <div className="pdash-notice" role="status" data-testid="lead-offer-sent">
          {offered === 'free'
            ? 'Teklifiniz iletildi. Vitrin ücretsiz teklif hakkınızdan karşılandı.'
            : 'Teklifiniz iletildi.'}
        </div>
      ) : null}
      {reported === '1' ? (
        <div className="pdash-notice" role="status" data-testid="report-received">
          Bildiriminiz alındı, ekibimiz inceleyecek.
        </div>
      ) : null}
      {reportError === 'exists' ? (
        <div className="pdash-notice pdash-notice-warn" role="alert">
          Bu talebi zaten bildirdiniz.
        </div>
      ) : null}
      {reportError === 'limit' ? (
        <div className="pdash-notice pdash-notice-warn" role="alert">
          Günlük bildirim sınırına ulaştınız.
        </div>
      ) : null}

      {lead.status === 'BREACHED' ? (
        <div className="pdash-notice pdash-notice-warn" role="status">
          Taahhüt ettiğiniz yanıt süresi doldu ve müşteriye talebini genel pazara açmak isteyip
          istemediği soruldu. Karar verene kadar hâlâ teklif verebilirsiniz.
        </div>
      ) : null}
      {lead.status === 'RELEASED' ? (
        <div className="pdash-notice pdash-notice-warn" role="status">
          Müşteri talebini genel pazara açtı. Bu talep artık sıradan bir taleptir; teklif vermek
          isterseniz &quot;Uygun talepler&quot; ekranından normal kredi bedeliyle verebilirsiniz.
        </div>
      ) : null}
      {lead.status === 'CLOSED_UNANSWERED' && lead.closeReason ? (
        <div className="pdash-notice" role="status">
          {SHOWCASE_LEAD_CLOSE_REASON_LABELS[lead.closeReason]}
        </div>
      ) : null}

      <section className="pdash-detail-card">
        <header className="pdash-section-head">
          <h2 className="pdash-section-title">Talep</h2>
          {/*
            The same report the ordinary request screen offers, because a
            direct lead reached this business without an operator reading it
            first. The lead payload does not carry the provider's own earlier
            report; a second attempt is answered by the API and shown above.
          */}
          {answerable ? (
            <ReportDialog
              providerId={id}
              requestId={lead.request.id}
              returnTo={`/providers/${id}/vitrin/talepler/${leadId}`}
            />
          ) : null}
        </header>
        <dl className="pdash-info-grid">
          <div className="pdash-info-row">
            <dt>Aciliyet</dt>
            <dd>
              {SHOWCASE_LEAD_URGENCY_LABELS[lead.urgencyBucket]} · {lead.slaHours} saat içinde
              dönüş
            </dd>
          </div>
          <div className="pdash-info-row">
            <dt>Son yanıt</dt>
            <dd>{leadDeadlineLabel(lead)}</dd>
          </div>
          <div className="pdash-info-row">
            <dt>Gönderen</dt>
            <dd>{lead.request.customerName}</dd>
          </div>
          <div className="pdash-info-row">
            <dt>Konum</dt>
            <dd>
              {[lead.request.neighborhood, lead.request.district, lead.request.city]
                .filter(Boolean)
                .join(', ')}
            </dd>
          </div>
          {lead.kind === 'SERVICE' && typeof lead.listedServicePriceAmount === 'number' ? (
            <div className="pdash-info-row">
              <dt>Kartta yazan hizmet bedeli</dt>
              {/*
                The price the customer actually read when they wrote, frozen on
                the lead. It is the provider's own price to their own customer —
                TakTick neither collects it nor is a party to it — and it is
                shown here because it is what this customer was promised.
              */}
              <dd>{formatPrice(lead.listedServicePriceAmount, 'TRY')}</dd>
            </div>
          ) : null}
          <div className="pdash-info-row">
            <dt>İş zamanı tercihi</dt>
            <dd>{lead.request.urgency ?? '—'}</dd>
          </div>
          <div className="pdash-info-row">
            <dt>Bütçe</dt>
            <dd>
              {lead.request.budgetMin === null && lead.request.budgetMax === null
                ? '—'
                : `${lead.request.budgetMin ? formatPrice(lead.request.budgetMin, 'TRY') : '…'} – ${
                    lead.request.budgetMax ? formatPrice(lead.request.budgetMax, 'TRY') : '…'
                  }`}
            </dd>
          </div>
          <div className="pdash-info-row">
            <dt>Kalite puanı</dt>
            {/*
              Shown on purpose, and it is one of the three mitigations for this
              flow skipping moderation on the way in: the text reached this
              business without an operator reading it, so the business gets the
              same signal an operator would have used.
            */}
            <dd>{lead.request.qualityScore}</dd>
          </div>
        </dl>

        {lead.request.description ? (
          <>
            <h3 className="pdash-section-title">Açıklama</h3>
            <p>{lead.request.description}</p>
          </>
        ) : null}

        {lead.request.answers.length > 0 ? (
          <>
            <h3 className="pdash-section-title">Form yanıtları</h3>
            <dl className="pdash-info-grid">
              {lead.request.answers.map((answer) => (
                <div className="pdash-info-row" key={answer.id}>
                  <dt>{answer.questionLabel}</dt>
                  <dd>{renderAnswer(answer.value)}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : null}
      </section>

      {lead.respondedOfferId ? (
        <section className="pdash-detail-card">
          <h2 className="pdash-section-title">Teklifiniz</h2>
          <p className="muted">
            Bu talebe {formatDateTime(lead.respondedAt ?? lead.createdAt)} tarihinde teklif
            verdiniz.
          </p>
          <div className="pdash-form-foot" style={{ justifyContent: 'flex-start' }}>
            <Link
              className="pdash-btn pdash-btn-secondary"
              href={`/providers/${id}/offers/${lead.respondedOfferId}`}
            >
              Teklifi görüntüle
            </Link>
          </div>
        </section>
      ) : answerable ? (
        <form action={createShowcaseLeadOfferAction} className="pdash-detail-card pdash-form">
          <input type="hidden" name="providerId" value={id} />
          <input type="hidden" name="leadId" value={leadId} />
          <input type="hidden" name="requestId" value={lead.request.id} />

          <header className="pdash-section-head">
            <h2 className="pdash-section-title">Teklif ver</h2>
          </header>

          <p className="pdash-form-hint" data-testid="lead-offer-allowance-hint">
            Bu talep vitrin kartınızdan geldi ve yalnız size iletildi.{' '}
            {lead.freeOfferCount === 0 && !costPreview?.allowance
              ? `${NO_FREE_OFFERS_TEXT}: bu vitrin yayın dönemi ücretsiz teklif içermez; teklifler kategori kredi maliyetinden ücretlendirilir.`
              : `${
                  costPreview?.allowance
                    ? `Bu vitrin yayın döneminde ${costPreview.allowance.quotaTotal} ücretsiz teklif hakkınız bulunur;`
                    : 'Her vitrin yayın dönemi, paketinizin içerdiği sayıda ücretsiz teklif hakkıyla gelir;'
                } haklarınız bittiğinde teklifler kategori kredi maliyetinden ücretlendirilir.`}
          </p>

          {/*
            The cost the API previewed, shown and posted back. A missing preview
            posts nothing, which the API treats as "not shown a price": it then
            refuses any paid answer with a 409 instead of charging it.
          */}
          <OfferCostPanel preview={costPreview} />
          {costPreview ? (
            <input type="hidden" name="expectedCreditCost" value={costPreview.creditCost} />
          ) : null}

          <OfferPriceField />

          <div className="pdash-form-grid">
            <label className="pdash-form-row">
              <span>Para birimi</span>
              <input name="currency" defaultValue="TRY" />
            </label>
            <OfferScheduleFields />
          </div>

          <label className="pdash-form-row">
            <span>Mesaj *</span>
            <textarea
              name="message"
              required
              placeholder="Müşteriye iletmek istediğiniz açıklama"
            />
          </label>
          <label className="pdash-form-row">
            <span>Garanti notu</span>
            <textarea name="warrantyNote" />
          </label>
          <label className="pdash-form-row">
            <span>İç not</span>
            <textarea name="internalNote" placeholder="Müşteri görmez, sadece sizin notunuz" />
          </label>

          <div className="pdash-form-foot">
            <button
              className="pdash-btn pdash-btn-primary"
              type="submit"
              aria-describedby={error ? 'lead-offer-error' : undefined}
            >
              {costPreview?.kind === 'SHOWCASE_ALLOWANCE'
                ? 'Teklifi gönder (ücretsiz hak)'
                : costPreview && costPreview.kind !== 'UNLIMITED'
                  ? `Teklifi gönder (${costPreview.creditCost} kredi)`
                  : 'Teklifi gönder'}
            </button>
          </div>
        </form>
      ) : null}
    </ProviderShell>
  );
}

/**
 * The API's preview of this answer's cost. Null when it cannot be read — the
 * form then posts no expectation and the API refuses a paid answer rather than
 * charging one nobody was shown.
 */
async function readOfferCost(providerId: string, requestId: string): Promise<OfferCostPreview | null> {
  try {
    return await apiFetch<OfferCostPreview>(`/providers/${providerId}/requests/${requestId}/offer-cost`);
  } catch {
    return null;
  }
}

/** A stored answer, printed without inventing structure the value does not have. */
function renderAnswer(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  if (typeof value === 'boolean') return value ? 'Evet' : 'Hayır';
  return String(value);
}
