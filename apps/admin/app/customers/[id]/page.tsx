import Link from 'next/link';
import {
  apiFetch,
  fetchOrNotFound,
  CustomerDetailResponse,
  CustomerNote,
  CustomerNotesResponse,
  CustomerRecentOffer,
  CustomerRecentRequest,
  customerOriginBadgeClass,
  customerOriginLabel,
  formatDate,
  formatDateTime,
  formatPrice,
  qualityBadgeClass,
  qualityLabel,
  requestStatusLabel,
  requireAdmin,
  statusBadgeClass,
  statusLabel,
} from '../../../lib/api';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import { DataTable, type DataColumn } from '../../../components/data-table';
import { DetailHeader } from '../../../components/detail-header';
import { EmptyState } from '../../../components/empty-state';
import { InfoPopover } from '../../../components/info-popover';
import { KeyValueList } from '../../../components/key-value-list';
import { SectionCard } from '../../../components/section-card';
import type { SummaryItem } from '../../../components/summary-strip';
import { Tabs, type TabItem } from '../../../components/tabs';
import { customerVerificationBadges, verificationBadgeClass } from '../../../lib/customer-verification';
import { resolveTab } from '../../../lib/list-query';
import { createCustomerNoteAction, updateCustomerStatusAction } from '../actions';
import { ActivationLinkForm } from './activation-link-form';

/**
 * Hizmet alan detayı (#8), design `customerDetail` (ADMIN-DESIGN-001 Faz 3B,
 * paket 2 `20`–`23`).
 *
 * The design's four tabs over the data this screen already read: the profile
 * and account access, the request history, the offers received, and the notes.
 * Every section keeps the permission it had:
 *
 * - The page itself is CUSTOMERS_READ.
 * - Notes are CUSTOMER_NOTES_READ (F7). Without it the Notlar tab is not
 *   drawn, `?tab=notlar` falls back to the profile, and the notes endpoint is
 *   never called — the rest of the customer stays readable.
 * - Adding a note is CUSTOMER_NOTES_WRITE, the account status CUSTOMERS_STATUS,
 *   the password link CUSTOMER_ACTIVATION_LINK_ISSUE. A control whose
 *   permission is missing is not rendered; the API refuses regardless.
 *
 * Passivating is the one destructive action here, and it asks first, saying
 * what it does (see PASSIVATE_CONSEQUENCE).
 */

type CustomerDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
};

type TabKey = '' | 'talepler' | 'teklifler' | 'notlar';
const TAB_KEYS: readonly TabKey[] = ['', 'talepler', 'teklifler', 'notlar'];

/** Which linked screens this session may open; a link it cannot follow is plain text. */
type RowLinks = { requests: boolean; offers: boolean; providers: boolean };

/** The design's ⓘ on "Hesap erişimi", fitted to how the link really works. */
const ACCESS_INFO =
  'Talep formundan otomatik oluşturulan hesabın şifresi yoktur; müşteri panele giremez. Buradan oluşturulan bağlantıyla müşteri şifresini belirler. Bağlantı 72 saat geçerlidir, yalnız bu ekranda bir kez gösterilir ve e-postayla gönderilmez: siz paylaşırsınız. Yeni bağlantı, kullanılmamış eski bağlantıları geçersiz kılar.';

/**
 * What `PATCH /customers/:id/status { isActive: false }` does, and what it
 * leaves alone (customers.service.ts `updateStatus`, auth.service.ts,
 * request-identity.service.ts).
 */
const PASSIVATE_CONSEQUENCE = (
  <>
    <p>
      Müşteri bir daha giriş yapamaz; açık oturumu bir sonraki isteğinde reddedilir. Bu telefon
      veya e-postayla misafir olarak yeni talep de gönderilemez.
    </p>
    <p>
      Mevcut talepleri, teklifleri ve notları silinmez, durumları değişmez. Hesap buradan yeniden
      etkinleştirilebilir.
    </p>
  </>
);

const REQUEST_COLUMNS: DataColumn[] = [
  { key: 'no', label: 'Talep no' },
  { key: 'category', label: 'Hizmet' },
  { key: 'location', label: 'Konum' },
  { key: 'quality', label: 'Kalite' },
  { key: 'status', label: 'Durum' },
  { key: 'date', label: 'Tarih' },
  { key: 'offers', label: 'Teklif', align: 'end' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

const OFFER_COLUMNS: DataColumn[] = [
  { key: 'no', label: 'Teklif no' },
  { key: 'request', label: 'Talep' },
  { key: 'provider', label: 'Hizmet veren' },
  { key: 'price', label: 'Tutar', align: 'end' },
  { key: 'status', label: 'Durum' },
  { key: 'date', label: 'Tarih' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

/** "Son 10 · toplam 14", or just the total when every row is on screen. */
function shownOfTotal(shown: number, total: number): string {
  return shown < total ? `Son ${shown} kayıt · toplam ${total}` : `Toplam ${total}`;
}

export default async function AdminCustomerDetailPage({
  params,
  searchParams,
}: CustomerDetailPageProps) {
  const { can } = await requireAdmin('CUSTOMERS_READ');
  const canReadNotes = can('CUSTOMER_NOTES_READ');
  const canWriteNotes = can('CUSTOMER_NOTES_WRITE');
  const canChangeStatus = can('CUSTOMERS_STATUS');
  const canIssueActivationLink = can('CUSTOMER_ACTIVATION_LINK_ISSUE');
  const links: RowLinks = {
    requests: can('REQUESTS_READ'),
    offers: can('OFFERS_READ'),
    providers: can('PROVIDERS_READ_DETAIL'),
  };
  const [{ id }, search] = await Promise.all([params, searchParams]);
  // A tab the session may not open is not a tab at all: `?tab=notlar`
  // without CUSTOMER_NOTES_READ opens the profile, never an empty panel.
  //
  // The same for the request and offer history: `GET /customers/:id` carries
  // those blocks — and the figures that count them — only for a session
  // holding REQUESTS_READ / OFFERS_READ (API-ADMIN-CROSS-DOMAIN-PROJECTION-RBAC-001).
  const tabKeys = TAB_KEYS.filter(
    (key) =>
      (key !== 'notlar' || canReadNotes) &&
      (key !== 'talepler' || links.requests) &&
      (key !== 'teklifler' || links.offers),
  );
  const activeTab = resolveTab<TabKey>(search.tab, tabKeys, '');

  // An unknown or malformed id is the 404 screen, as on every other detail
  // (`fetchOrNotFound`: 404 and 400 alike), never the error screen.
  const [response, notesResponse] = await fetchOrNotFound(() =>
    Promise.all([
      apiFetch<CustomerDetailResponse>(`/customers/${id}`),
      // Read only under its own permission: without it the notes endpoint is
      // not called, so CUSTOMERS_READ alone still opens the page (F7).
      canReadNotes
        ? apiFetch<CustomerNotesResponse>(`/customers/${id}/notes`)
        : Promise.resolve<CustomerNotesResponse | null>(null),
    ]),
  );
  const { customer, metrics } = response;
  // Absent, not empty, without the permission; the tabs above are gone then.
  const recentRequests = response.recentRequests ?? [];
  const recentOffers = response.recentOffers ?? [];
  const acceptedOffers = response.acceptedOffers ?? [];
  const requestCount = metrics.requestCount ?? 0;
  const offerCount = metrics.offerCount ?? 0;
  const acceptedOfferCount = metrics.acceptedOfferCount ?? 0;
  const notes = notesResponse?.items ?? [];
  const path = `/customers/${customer.id}`;

  const displayName = customer.name ?? customer.email ?? customer.phone ?? '—';
  // From the two account columns alone; a verified request of this customer
  // is not an account proof (see lib/customer-verification.ts).
  const [emailProof, phoneProof] = customerVerificationBadges(customer);
  const latestRequest = recentRequests[0] ?? null;
  const location = latestRequest
    ? `${latestRequest.city}${latestRequest.district ? `, ${latestRequest.district}` : ''}`
    : null;

  const tabs: TabItem[] = [
    { key: '', label: 'Profil ve iletişim', testId: 'customer-tab-profil' },
    ...(links.requests
      ? [{ key: 'talepler', label: 'Talep geçmişi', count: requestCount, testId: 'customer-tab-talepler' }]
      : []),
    ...(links.offers
      ? [{ key: 'teklifler', label: 'Aldığı teklifler', count: offerCount, testId: 'customer-tab-teklifler' }]
      : []),
    ...(canReadNotes
      ? [{ key: 'notlar', label: 'Notlar', count: notes.length, testId: 'customer-tab-notlar' }]
      : []),
  ];

  const facts: SummaryItem[] = [
    ...(links.requests
      ? [{ label: 'Talep sayısı', value: String(requestCount), testId: 'customer-fact-requests' }]
      : []),
    ...(links.offers
      ? [
          { label: 'Aldığı teklif', value: String(offerCount), testId: 'customer-fact-offers' },
          {
            label: 'Kabul ettiği teklif',
            value: String(acceptedOfferCount),
            tone: (acceptedOfferCount > 0 ? 'success' : 'neutral') as SummaryItem['tone'],
          },
        ]
      : []),
    ...(links.requests
      ? [
          {
            label: 'Son talep',
            value: metrics.lastRequestAt ? formatDateTime(metrics.lastRequestAt) : '—',
            note: latestRequest
              ? `${latestRequest.categoryName} · ${latestRequest.district || latestRequest.city}`
              : 'Henüz talep yok',
          },
        ]
      : []),
    {
      label: 'Hesap',
      value: customer.isActive ? 'Aktif' : 'Pasif',
      note: customer.hasPassword ? 'Şifre belirlenmiş' : 'Şifre belirlenmemiş',
      tone: customer.isActive ? (customer.hasPassword ? 'success' : 'warning') : 'danger',
      testId: 'customer-fact-account',
    },
  ];

  return (
    <main className="customer-detail-page">
      <DetailHeader
        back={{ href: '/customers', label: 'Hizmet alanlar' }}
        badges={
          <>
            {customer.isActive ? (
              <span className="badge badge-good" data-testid="customer-status">
                Aktif hesap
              </span>
            ) : (
              <span className="badge badge-bad" data-testid="customer-status">
                Pasif hesap
              </span>
            )}
            <span className={customerOriginBadgeClass(customer.customerOrigin)}>
              {customerOriginLabel(customer.customerOrigin)}
            </span>
          </>
        }
        meta={<>{formatDate(customer.createdAt)} tarihinden beri kayıtlı</>}
        title={displayName}
        subtitle={[
          customer.phone ?? 'telefon kayıtlı değil',
          customer.email ?? 'e-posta kayıtlı değil',
          location,
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <>
            {canReadNotes && canWriteNotes ? (
              <Link className="btn btn-secondary btn-sm" href={`${path}?tab=notlar#not-ekle`}>
                Not ekle
              </Link>
            ) : null}
            {canChangeStatus ? <CustomerStatusAction customerId={customer.id} isActive={customer.isActive} /> : null}
          </>
        }
        facts={facts}
        factsLabel="Müşteri özeti"
        testId="customer-header"
      />

      <Tabs label="Müşteri sekmeleri" items={tabs} active={activeTab} path={path} testId="customer-tabs" />

      {activeTab === '' ? (
        <div className="detail-panel" data-testid="customer-panel-profil">
          <div className="detail-panel-grid">
            <SectionCard title="Profil ve iletişim">
              <KeyValueList
                items={[
                  { label: 'Ad soyad', value: customer.name },
                  {
                    label: 'Telefon',
                    value: (
                      <>
                        {customer.phone ? (
                          <a className="cell-link" href={`tel:${customer.phone}`}>
                            {customer.phone}
                          </a>
                        ) : (
                          'Kayıtlı değil'
                        )}
                        <VerificationLine channel="phone" proof={phoneProof} />
                      </>
                    ),
                  },
                  {
                    label: 'E-posta',
                    value: (
                      <>
                        {customer.email ? (
                          <a className="cell-link cell-break" href={`mailto:${customer.email}`}>
                            {customer.email}
                          </a>
                        ) : (
                          'Kayıtlı değil'
                        )}
                        <VerificationLine channel="email" proof={emailProof} />
                      </>
                    ),
                  },
                  // Read from the latest request, so only where the requests are.
                  ...(links.requests
                    ? [
                        {
                          label: 'Şehir',
                          value: location ? (
                            <>
                              {location}
                              <div className="cell-muted">Son talebinden</div>
                            </>
                          ) : null,
                        },
                      ]
                    : []),
                  { label: 'Kayıt tarihi', value: formatDateTime(customer.createdAt) },
                  {
                    label: 'Son giriş',
                    value: customer.lastLoginAt ? (
                      formatDateTime(customer.lastLoginAt)
                    ) : (
                      <>
                        Hiç girmedi
                        {!customer.hasPassword ? <div className="cell-muted">Şifre belirlenmemiş</div> : null}
                      </>
                    ),
                  },
                  {
                    label: 'Müşteri tipi',
                    value: (
                      <>
                        {customerOriginLabel(customer.customerOrigin)}
                        {customer.customerOrigin === 'AUTO_CREATED_REQUEST' ? (
                          <div className="cell-muted">
                            Talep formu üzerinden otomatik oluşturuldu; normal kayıt sürecini tamamlamamış
                            olabilir.
                          </div>
                        ) : null}
                      </>
                    ),
                  },
                  {
                    label: 'Hesap durumu',
                    value: customer.isActive ? (
                      <span className="badge badge-good">Aktif</span>
                    ) : (
                      <span className="badge badge-bad">Pasif</span>
                    ),
                  },
                  { label: 'Güncellenme', value: formatDateTime(customer.updatedAt) },
                  {
                    label: 'Müşteri ID',
                    value: (
                      <details className="muted technical-id">
                        <summary>Teknik bilgi</summary>
                        <code>{customer.id}</code>
                      </details>
                    ),
                  },
                ]}
              />
            </SectionCard>

            <CustomerAccessSection customer={customer} canIssue={canIssueActivationLink} />
          </div>
        </div>
      ) : null}

      {activeTab === 'talepler' && links.requests ? (
        <div className="detail-panel" data-testid="customer-panel-talepler">
          <SectionCard
            title="Açtığı talepler"
            subtitle={requestCount > 0 ? shownOfTotal(recentRequests.length, requestCount) : undefined}
          >
            {recentRequests.length === 0 ? (
              <EmptyState
                title="Henüz talep yok."
                description="Müşteri bir talep gönderdiğinde burada listelenir."
              />
            ) : (
              <DataTable caption="Açtığı talepler" columns={REQUEST_COLUMNS} minWidth={860} testId="customer-requests">
                {recentRequests.map((request) => (
                  <CustomerRequestRow key={request.id} request={request} links={links} />
                ))}
              </DataTable>
            )}
          </SectionCard>
        </div>
      ) : null}

      {activeTab === 'teklifler' && links.offers ? (
        <div className="detail-panel" data-testid="customer-panel-teklifler">
          <SectionCard
            title="Aldığı teklifler"
            subtitle={
              offerCount > 0
                ? `${offerCount} teklifin ${acceptedOfferCount} tanesini kabul etti`
                : undefined
            }
          >
            {recentOffers.length === 0 ? (
              <EmptyState
                title="Henüz teklif yok."
                description="Müşterinin taleplerine hizmet verenler teklif gönderdiğinde burada listelenir."
              />
            ) : (
              <>
                {recentOffers.length < offerCount ? (
                  <p className="detail-muted-note">
                    {shownOfTotal(recentOffers.length, offerCount)}
                  </p>
                ) : null}
                <DataTable caption="Aldığı teklifler" columns={OFFER_COLUMNS} minWidth={860} testId="customer-offers">
                  {recentOffers.map((offer) => (
                    <CustomerOfferRow key={offer.id} offer={offer} links={links} />
                  ))}
                </DataTable>
              </>
            )}
          </SectionCard>

          <SectionCard
            title="Kabul ettiği teklifler"
            subtitle={
              acceptedOfferCount > 0
                ? shownOfTotal(acceptedOffers.length, acceptedOfferCount)
                : undefined
            }
          >
            {acceptedOffers.length === 0 ? (
              <EmptyState
                title="Henüz kabul edilmiş teklif yok."
                description="Müşteri bir teklifi kabul ettiğinde burada görünür."
              />
            ) : (
              <DataTable
                caption="Kabul ettiği teklifler"
                columns={OFFER_COLUMNS}
                minWidth={860}
                testId="customer-accepted-offers"
              >
                {acceptedOffers.map((offer) => (
                  <CustomerOfferRow key={offer.id} offer={offer} links={links} />
                ))}
              </DataTable>
            )}
          </SectionCard>
        </div>
      ) : null}

      {activeTab === 'notlar' && canReadNotes ? (
        <div className="detail-panel" data-testid="customer-panel-notlar">
          <SectionCard
            title="Operasyon notları"
            subtitle={notes.length > 0 ? `Toplam ${notes.length}` : undefined}
            className="customer-notes-card"
          >
            {canWriteNotes ? (
              <form action={createCustomerNoteAction} className="detail-form customer-note-form" id="not-ekle">
                <input type="hidden" name="customerId" value={customer.id} />
                <label className="detail-form-field" htmlFor="customer-note">
                  <span>Yeni not</span>
                  <textarea
                    id="customer-note"
                    name="note"
                    required
                    minLength={2}
                    maxLength={2000}
                    rows={3}
                    placeholder="Bu müşteriyle ilgili operasyonel bir not yazın — yalnız ekip görür."
                  />
                </label>
                <div className="detail-form-actions">
                  <button type="submit" className="btn btn-primary btn-sm">
                    Notu ekle
                  </button>
                </div>
              </form>
            ) : null}

            {notes.length === 0 ? (
              <EmptyState
                title="Henüz müşteri notu yok."
                description="Ekipten biri not eklediğinde burada, en yenisi önce görünür."
              />
            ) : (
              <ul className="customer-note-list" data-testid="customer-notes">
                {notes.map((note) => (
                  <CustomerNoteItem key={note.id} note={note} />
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      ) : null}
    </main>
  );
}

/**
 * "Hesabı pasife al" behind a confirmation; turning an account back on is not
 * destructive and goes straight through. Both are the same form and action as
 * before.
 */
function CustomerStatusAction({ customerId, isActive }: { customerId: string; isActive: boolean }) {
  return (
    <form action={updateCustomerStatusAction}>
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="isActive" value={isActive ? 'false' : 'true'} />
      {isActive ? (
        <ConfirmDialog
          triggerLabel="Hesabı pasife al"
          triggerClassName="btn btn-destructive btn-sm"
          title="Hesap pasife alınsın mı?"
          consequence={PASSIVATE_CONSEQUENCE}
          confirmLabel="Evet, pasife al"
          testId="customer-passivate"
        />
      ) : (
        <button type="submit" className="btn btn-primary btn-sm" data-testid="customer-activate">
          Hesabı etkinleştir
        </button>
      )}
    </form>
  );
}

/**
 * "Hesap erişimi": only for an account the request form created, because only
 * that one can be without a password the customer chose.
 */
function CustomerAccessSection({
  customer,
  canIssue,
}: {
  customer: CustomerDetailResponse['customer'];
  canIssue: boolean;
}) {
  if (customer.customerOrigin !== 'AUTO_CREATED_REQUEST') {
    return null;
  }

  const info = (
    <InfoPopover label="Hesap erişimi nasıl çalışır?" size="sm">
      {ACCESS_INFO}
    </InfoPopover>
  );

  if (customer.hasPassword) {
    return (
      <SectionCard title="Hesap erişimi" actions={info} id="hesap-erisimi">
        <p className="detail-muted-note">
          Aktivasyon tamamlandı. Bu müşteri şifresini belirlemiş; yeni bağlantı oluşturmaya gerek
          yok.
        </p>
      </SectionCard>
    );
  }

  if (!customer.isActive) {
    return (
      <SectionCard title="Hesap erişimi" actions={info} id="hesap-erisimi">
        <p className="detail-muted-note">
          Pasif müşteri için şifre belirleme bağlantısı oluşturulamaz. Önce hesabı etkinleştirin.
        </p>
      </SectionCard>
    );
  }

  // Issuing is the only thing left to show. Without the permission there is
  // nothing to offer, so the card is not rendered.
  if (!canIssue) {
    return null;
  }

  return (
    <SectionCard title="Hesap erişimi" actions={info} id="hesap-erisimi">
      <p className="detail-muted-note customer-access-lead">
        Bu müşteri talep formu üzerinden otomatik oluşturuldu ve henüz şifre belirlemedi — panele
        giremez. Bağlantıyı oluşturup WhatsApp, SMS veya e-postayla kendiniz paylaşın.
      </p>
      <ActivationLinkForm customerId={customer.id} />
    </SectionCard>
  );
}

function CustomerRequestRow({
  request,
  links,
}: {
  request: CustomerRecentRequest;
  links: RowLinks;
}) {
  const requestRef = request.requestNumber ?? `#${request.id.slice(-8)}`;
  return (
    <tr data-testid="customer-request-row">
      <td className="cell-nowrap">
        <code className="display-number">{requestRef}</code>
      </td>
      <td>{request.categoryName}</td>
      <td>
        {request.city}
        {request.district ? ` · ${request.district}` : ''}
      </td>
      <td>
        <span className={qualityBadgeClass(request.qualityLabel)}>{qualityLabel(request.qualityLabel)}</span>
      </td>
      <td>
        <span className={statusBadgeClass(request.status)}>{requestStatusLabel(request.status)}</span>
      </td>
      <td>{formatDateTime(request.submittedAt)}</td>
      <td className="is-num">
        {request.offerCount === 0 ? (
          <span className="cell-muted">0</span>
        ) : (
          <span className="badge badge-good">{request.offerCount}</span>
        )}
      </td>
      <td className="col-actions">
        {links.requests ? (
          <Link className="btn btn-secondary btn-sm" href={`/requests/${request.id}`} aria-label={`Aç: ${requestRef}`}>
            Aç
          </Link>
        ) : null}
      </td>
    </tr>
  );
}

function CustomerNoteItem({ note }: { note: CustomerNote }) {
  const authorName = note.createdBy?.name ?? note.createdBy?.email ?? 'Bilinmeyen kullanıcı';
  return (
    <li className="customer-note" data-testid="customer-note">
      <div className="customer-note-head">
        <strong>{authorName}</strong>
        <time dateTime={note.createdAt}>{formatDateTime(note.createdAt)}</time>
      </div>
      <p className="customer-note-body">{note.note}</p>
    </li>
  );
}

function CustomerOfferRow({ offer, links }: { offer: CustomerRecentOffer; links: RowLinks }) {
  const offerRef = offer.offerNumber ?? `#${offer.id.slice(-8)}`;
  const requestRef = offer.requestNumber ?? `#${offer.requestId.slice(-8)}`;
  return (
    <tr data-testid="customer-offer-row">
      <td className="cell-nowrap">
        <code className="display-number">{offerRef}</code>
      </td>
      <td className="cell-nowrap">
        {links.requests ? (
          <Link href={`/requests/${offer.requestId}`}>
            <code className="display-number">{requestRef}</code>
          </Link>
        ) : (
          <code className="display-number">{requestRef}</code>
        )}
      </td>
      <td>
        {links.providers ? (
          <Link href={`/providers/${offer.providerId}`}>{offer.providerName}</Link>
        ) : (
          offer.providerName
        )}
      </td>
      <td className="is-num">
        <strong>{formatPrice(offer.priceAmount, offer.currency)}</strong>
      </td>
      <td>
        <span className={statusBadgeClass(offer.status)}>{statusLabel(offer.status)}</span>
      </td>
      <td>{formatDateTime(offer.submittedAt)}</td>
      <td className="col-actions">
        {links.offers ? (
          <Link className="btn btn-secondary btn-sm" href={`/offers/${offer.id}`} aria-label={`Aç: ${offerRef}`}>
            Aç
          </Link>
        ) : null}
      </td>
    </tr>
  );
}

/**
 * Under the phone and the e-mail: "Doğrulandı · 12 Eyl 2026 09:30" as an ink
 * pill with its moment, or a muted "Doğrulanmadı" with no moment and no red.
 */
function VerificationLine({
  channel,
  proof,
}: {
  channel: 'email' | 'phone';
  proof: ReturnType<typeof customerVerificationBadges>[number];
}) {
  return (
    <div
      className="customer-verification-line"
      data-testid={`customer-${channel}-verification`}
      data-verified={proof.verified ? 'true' : 'false'}
    >
      <span className={verificationBadgeClass(proof)} aria-label={proof.ariaLabel}>
        {proof.label}
      </span>
      {proof.at ? <span className="muted customer-verification-at">{formatDateTime(proof.at)}</span> : null}
    </div>
  );
}
