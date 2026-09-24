import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  apiFetch,
  CustomerDetailResponse,
  CustomerNote,
  CustomerNotesResponse,
  CustomerRecentOffer,
  CustomerRecentRequest,
  customerOriginBadgeClass,
  customerOriginLabel,
  formatDateTime,
  formatPrice,
  qualityBadgeClass,
  qualityLabel,
  requestStatusLabel,
  requireAdmin,
  statusBadgeClass,
  statusLabel,
} from '../../../lib/api';
import { EmptyState } from '../../../components/empty-state';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { StatCard } from '../../../components/stat-card';
import { customerVerificationBadges, verificationBadgeClass } from '../../../lib/customer-verification';
import {
  createCustomerNoteAction,
  updateCustomerStatusAction,
} from '../actions';
import { ActivationLinkForm } from './activation-link-form';

type CustomerDetailPageProps = {
  params: Promise<{ id: string }>;
};

/** Which linked screens this session may open; a link it cannot follow is plain text. */
type RowLinks = { requests: boolean; offers: boolean; providers: boolean };

// apiFetch backend hatası geldiğinde body metnini Error.message'a koyar.
// Backend NestJS NotFoundException JSON şekli: {"statusCode":404,...}.
function isBackendNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  try {
    const parsed = JSON.parse(error.message) as { statusCode?: unknown };
    return parsed?.statusCode === 404;
  } catch {
    return error.message.includes('Customer not found');
  }
}

export default async function AdminCustomerDetailPage({
  params,
}: CustomerDetailPageProps) {
  const { can } = await requireAdmin('CUSTOMERS_READ');
  // Notes are their own permission. Without it the card is not rendered and
  // the notes endpoint is not called, so CUSTOMERS_READ alone opens the page.
  const canReadNotes = can('CUSTOMER_NOTES_READ');
  const canWriteNotes = can('CUSTOMER_NOTES_WRITE');
  const canChangeStatus = can('CUSTOMERS_STATUS');
  const canIssueActivationLink = can('CUSTOMER_ACTIVATION_LINK_ISSUE');
  const canOpenRequests = can('REQUESTS_READ');
  const canOpenOffers = can('OFFERS_READ');
  const canOpenProviders = can('PROVIDERS_READ_DETAIL');
  const links: RowLinks = {
    requests: canOpenRequests,
    offers: canOpenOffers,
    providers: canOpenProviders,
  };
  const { id } = await params;

  let response: CustomerDetailResponse;
  let notesResponse: CustomerNotesResponse | null;
  try {
    [response, notesResponse] = await Promise.all([
      apiFetch<CustomerDetailResponse>(`/customers/${id}`),
      canReadNotes
        ? apiFetch<CustomerNotesResponse>(`/customers/${id}/notes`)
        : Promise.resolve(null),
    ]);
  } catch (error) {
    if (isBackendNotFound(error)) {
      notFound();
    }
    throw error;
  }
  const { customer, metrics, recentRequests, recentOffers, acceptedOffers } = response;
  const notes = notesResponse?.items ?? [];

  const displayName = customer.name ?? customer.email ?? customer.phone ?? '—';
  // From the two account columns alone; a verified request of this customer
  // is not an account proof (see lib/customer-verification.ts).
  const [emailProof, phoneProof] = customerVerificationBadges(customer);
  const subtitleParts: string[] = [];
  if (customer.phone) subtitleParts.push(customer.phone);
  if (customer.email) subtitleParts.push(customer.email);

  return (
    <main className="customer-detail-page">
      <PageHeader
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Hizmet Alanlar', href: '/customers' },
          { label: displayName },
        ]}
        title={displayName}
        subtitle={
          <>
            {customer.isActive ? (
              <span className="badge badge-good">Aktif</span>
            ) : (
              <span className="badge badge-bad">Pasif</span>
            )}
            {subtitleParts.length > 0 ? (
              <span className="muted"> · {subtitleParts.join(' · ')}</span>
            ) : null}
          </>
        }
        actions={
          <Link className="btn btn-ghost btn-sm" href="/customers">
            ← Listeye dön
          </Link>
        }
      />

      <section className="stat-grid">
        <StatCard label="Talep sayısı" value={metrics.requestCount} />
        <StatCard label="Teklif sayısı" value={metrics.offerCount} />
        <StatCard
          label="Kabul edilen teklif"
          value={metrics.acceptedOfferCount}
          tone={metrics.acceptedOfferCount > 0 ? 'success' : 'neutral'}
        />
        <StatCard
          label="Son talep"
          value={metrics.lastRequestAt ? formatDateTime(metrics.lastRequestAt) : '—'}
          hint={metrics.lastRequestAt ? undefined : 'Henüz talep yok'}
        />
      </section>

      <div className="provider-detail-card-grid">
        <CustomerActivationSection
          customer={customer}
          canIssue={canIssueActivationLink}
        />

        <SectionCard title="Profil & İletişim" className="card-wide">
          <dl className="meta-row">
            <dt>Ad</dt>
            <dd>{customer.name ?? '-'}</dd>
            <dt>Telefon</dt>
            <dd>
              {customer.phone ? (
                <a className="cell-link" href={`tel:${customer.phone}`}>
                  {customer.phone}
                </a>
              ) : (
                '-'
              )}
              <VerificationLine channel="phone" proof={phoneProof} />
            </dd>
            <dt>E-posta</dt>
            <dd>
              {customer.email ? (
                <a className="cell-link" href={`mailto:${customer.email}`}>
                  {customer.email}
                </a>
              ) : (
                '-'
              )}
              <VerificationLine channel="email" proof={emailProof} />
            </dd>
            <dt>Durum</dt>
            <dd>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {customer.isActive ? (
                  <span className="badge badge-good">Aktif</span>
                ) : (
                  <span className="badge badge-bad">Pasif</span>
                )}
                {canChangeStatus ? (
                <form action={updateCustomerStatusAction}>
                  <input type="hidden" name="customerId" value={customer.id} />
                  <input
                    type="hidden"
                    name="isActive"
                    value={customer.isActive ? 'false' : 'true'}
                  />
                  <button
                    type="submit"
                    className={
                      customer.isActive ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm'
                    }
                  >
                    {customer.isActive ? 'Pasifleştir' : 'Aktifleştir'}
                  </button>
                </form>
                ) : null}
              </div>
              <div
                className="muted"
                style={{ marginTop: 6, fontSize: 12, lineHeight: 1.4 }}
              >
                Bu alan müşterinin aktiflik durumunu yönetmek için kullanılır.
              </div>
            </dd>
            <dt>Müşteri tipi</dt>
            <dd>
              <span className={customerOriginBadgeClass(customer.customerOrigin)}>
                {customerOriginLabel(customer.customerOrigin)}
              </span>
              {customer.customerOrigin === 'AUTO_CREATED_REQUEST' ? (
                <div
                  className="muted"
                  style={{ marginTop: 6, fontSize: 12, lineHeight: 1.4 }}
                >
                  Bu müşteri, talep formu üzerinden otomatik oluşturuldu. Henüz
                  normal kayıt sürecini tamamlamamış olabilir.
                </div>
              ) : null}
            </dd>
            <dt>Kayıt tarihi</dt>
            <dd>{formatDateTime(customer.createdAt)}</dd>
            <dt>Son giriş</dt>
            <dd>{customer.lastLoginAt ? formatDateTime(customer.lastLoginAt) : '-'}</dd>
            <dt>Güncellenme</dt>
            <dd>{formatDateTime(customer.updatedAt)}</dd>
          </dl>
          <details style={{ marginTop: 12 }}>
            <summary className="cell-muted" style={{ cursor: 'pointer', fontSize: 12 }}>
              Teknik bilgi
            </summary>
            <dl className="meta-row" style={{ marginTop: 8 }}>
              <dt>Müşteri ID</dt>
              <dd>
                <code style={{ fontSize: 12 }}>{customer.id}</code>
              </dd>
            </dl>
          </details>
        </SectionCard>

        {canReadNotes ? (
        <SectionCard
          title="Müşteri Notları"
          subtitle={notes.length > 0 ? `Toplam ${notes.length}` : undefined}
          className="card-wide"
        >
          {canWriteNotes ? (
          <form
            action={createCustomerNoteAction}
            style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}
          >
            <input type="hidden" name="customerId" value={customer.id} />
            <textarea
              className="input"
              name="note"
              required
              minLength={2}
              maxLength={2000}
              rows={3}
              placeholder="Müşteriyle ilgili operasyonel bir not ekleyin..."
            />
            <div>
              <button type="submit" className="btn btn-primary btn-sm">
                Not ekle
              </button>
            </div>
          </form>
          ) : null}

          {notes.length === 0 ? (
            <EmptyState title="Henüz müşteri notu yok." />
          ) : (
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              {notes.map((note) => (
                <CustomerNoteItem key={note.id} note={note} />
              ))}
            </ul>
          )}
        </SectionCard>
        ) : null}

        <SectionCard
          title="Talep geçmişi"
          subtitle={metrics.requestCount > 0 ? `Toplam ${metrics.requestCount}` : undefined}
          className="card-wide"
        >
          {recentRequests.length === 0 ? (
            <EmptyState title="Henüz talep yok." />
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Talep No</th>
                    <th>Kategori</th>
                    <th>Konum</th>
                    <th>Kalite</th>
                    <th>Durum</th>
                    <th>Tarih</th>
                    <th className="col-num">Teklif</th>
                    <th className="col-actions">İşlem</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRequests.map((request) => (
                    <CustomerRequestRow key={request.id} request={request} links={links} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Aldığı teklifler"
          subtitle={metrics.offerCount > 0 ? `Toplam ${metrics.offerCount}` : undefined}
          className="card-wide"
        >
          {recentOffers.length === 0 ? (
            <EmptyState title="Henüz teklif yok." />
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Teklif No</th>
                    <th>Talep No</th>
                    <th>Hizmet Veren</th>
                    <th>Fiyat</th>
                    <th>Durum</th>
                    <th>Tarih</th>
                    <th className="col-actions">İşlem</th>
                  </tr>
                </thead>
                <tbody>
                  {recentOffers.map((offer) => (
                    <CustomerOfferRow key={offer.id} offer={offer} links={links} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Kabul edilen teklifler"
          subtitle={
            metrics.acceptedOfferCount > 0
              ? `Toplam ${metrics.acceptedOfferCount}`
              : undefined
          }
          className="card-wide"
        >
          {acceptedOffers.length === 0 ? (
            <EmptyState title="Henüz kabul edilmiş teklif yok." />
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Teklif No</th>
                    <th>Talep No</th>
                    <th>Hizmet Veren</th>
                    <th>Fiyat</th>
                    <th>Durum</th>
                    <th>Tarih</th>
                    <th className="col-actions">İşlem</th>
                  </tr>
                </thead>
                <tbody>
                  {acceptedOffers.map((offer) => (
                    <CustomerOfferRow key={offer.id} offer={offer} links={links} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </div>
    </main>
  );
}

function CustomerActivationSection({
  customer,
  canIssue,
}: {
  customer: CustomerDetailResponse['customer'];
  canIssue: boolean;
}) {
  if (customer.customerOrigin !== 'AUTO_CREATED_REQUEST') {
    return null;
  }

  if (customer.hasPassword) {
    return (
      <SectionCard title="Hesap aktivasyonu" className="card-wide">
        <p className="muted" style={{ marginTop: 0, lineHeight: 1.5 }}>
          Aktivasyon tamamlandı. Bu müşteri şifresini belirlemiş; yeni aktivasyon bağlantısı
          oluşturulmasına gerek yok.
        </p>
      </SectionCard>
    );
  }

  if (!customer.isActive) {
    return (
      <SectionCard title="Hesap aktivasyonu" className="card-wide">
        <p className="muted" style={{ marginTop: 0, lineHeight: 1.5 }}>
          Pasif müşteri için aktivasyon linki oluşturulamaz. Önce müşteriyi aktifleştirin.
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
    <SectionCard title="Hesap aktivasyonu" className="card-wide">
      <div style={{ marginBottom: 12 }}>
        <p className="muted" style={{ marginTop: 0, lineHeight: 1.5 }}>
          Bu müşteri talep formu üzerinden otomatik oluşturuldu. Hesabını kullanabilmesi için şifre
          belirleme bağlantısı oluşturabilirsiniz. Bağlantıyı kopyalayıp WhatsApp / SMS / e-posta
          ile manuel olarak paylaşın.
        </p>
        <ActivationLinkForm customerId={customer.id} />
      </div>
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
    <tr>
      <td>
        <code className="display-number">{requestRef}</code>
      </td>
      <td>{request.categoryName}</td>
      <td>
        {request.city}
        {request.district ? `/${request.district}` : ''}
      </td>
      <td>
        <span className={qualityBadgeClass(request.qualityLabel)}>
          {qualityLabel(request.qualityLabel)}
        </span>
      </td>
      <td>
        <span className={statusBadgeClass(request.status)}>
          {requestStatusLabel(request.status)}
        </span>
      </td>
      <td>{formatDateTime(request.submittedAt)}</td>
      <td className="col-num">
        {request.offerCount === 0 ? (
          <span className="cell-muted">0</span>
        ) : (
          <span className="badge badge-good">{request.offerCount}</span>
        )}
      </td>
      <td className="col-actions">
        {links.requests ? (
          <Link className="btn btn-secondary btn-sm" href={`/requests/${request.id}`}>
            Detay
          </Link>
        ) : null}
      </td>
    </tr>
  );
}

function CustomerNoteItem({ note }: { note: CustomerNote }) {
  const authorName = note.createdBy?.name ?? note.createdBy?.email ?? 'Bilinmeyen kullanıcı';
  return (
    <li
      style={{
        border: '1px solid var(--border, #e5e7eb)',
        borderRadius: 8,
        padding: 12,
        background: 'var(--surface-soft, #f9fafb)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 12,
          marginBottom: 6,
          fontSize: 12,
        }}
      >
        <strong>{authorName}</strong>
        <span className="muted">{formatDateTime(note.createdAt)}</span>
      </div>
      <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{note.note}</div>
    </li>
  );
}

function CustomerOfferRow({ offer, links }: { offer: CustomerRecentOffer; links: RowLinks }) {
  const offerRef = offer.offerNumber ?? `#${offer.id.slice(-8)}`;
  const requestRef = offer.requestNumber ?? `#${offer.requestId.slice(-8)}`;
  return (
    <tr>
      <td>
        <code className="display-number">{offerRef}</code>
      </td>
      <td>
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
      <td>{formatPrice(offer.priceAmount, offer.currency)}</td>
      <td>
        <span className={statusBadgeClass(offer.status)}>{statusLabel(offer.status)}</span>
      </td>
      <td>{formatDateTime(offer.submittedAt)}</td>
      <td className="col-actions">
        {links.offers ? (
          <Link className="btn btn-secondary btn-sm" href={`/offers/${offer.id}`}>
            Detay
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
      {proof.at ? (
        <span className="muted customer-verification-at">{formatDateTime(proof.at)}</span>
      ) : null}
    </div>
  );
}
