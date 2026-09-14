import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  fetchOrNotFound,
  formatDateTime,
  formatPrice,
  getCurrentUser,
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
 * 1. **This costs nothing.** The provider paid for the placement; the offer is
 *    free, and the sentence saying so sits next to the button rather than in a
 *    help page. Every other offer screen shows a credit cost here.
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

      {error ? (
        <div className="pdash-notice pdash-notice-error" role="alert">
          Teklif gönderilemedi. Bilgileri kontrol edip tekrar deneyin.
        </div>
      ) : null}
      {offered ? (
        <div className="pdash-notice" role="status">
          Teklifiniz iletildi. Bu talep için teklif kredisi harcanmadı.
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

          {/*
            No `expectedCreditCost` field, and no cost line. There is nothing to
            agree on: the placement is already paid for, and the resolver charges
            nothing for the provider this request is reserved for.
          */}
          <p className="pdash-form-hint">
            Bu talep vitrin kartınızdan geldi ve yalnız size iletildi. Teklif vermek için
            teklif kredisi harcanmaz.
          </p>

          <label className="pdash-form-row">
            <span>Teklif tutarı *</span>
            <input
              name="priceAmount"
              type="number"
              step="0.01"
              min="1"
              inputMode="decimal"
              placeholder="Örn. 1500.00"
              required
            />
            <small>Ondalıklı fiyat girebilirsiniz. Örn: 149,90 veya 1500.00 TRY.</small>
          </label>

          <div className="pdash-form-grid">
            <label className="pdash-form-row">
              <span>Para birimi</span>
              <input name="currency" defaultValue="TRY" />
            </label>
            <label className="pdash-form-row">
              <span>Tahmini başlangıç</span>
              <input name="estimatedStartDate" type="date" />
            </label>
            <label className="pdash-form-row">
              <span>Tahmini bitiş</span>
              <input name="estimatedCompletionDate" type="date" />
            </label>
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
            <button className="pdash-btn pdash-btn-primary" type="submit">
              Teklifi gönder
            </button>
          </div>
        </form>
      ) : null}
    </ProviderShell>
  );
}

/** A stored answer, printed without inventing structure the value does not have. */
function renderAnswer(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  if (typeof value === 'boolean') return value ? 'Evet' : 'Hayır';
  return String(value);
}
