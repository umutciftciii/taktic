import Link from 'next/link';
import { apiFetch, ProviderRequestDetail, RequestQualityBreakdownComponent } from '../../../../../lib/api';
import { createOfferAction } from './actions';

type ProviderRequestDetailPageProps = {
  params: Promise<{ id: string; requestId: string }>;
};

export default async function ProviderRequestDetailPage({ params }: ProviderRequestDetailPageProps) {
  const { id, requestId } = await params;
  const request = await apiFetch<ProviderRequestDetail>(`/providers/${id}/requests/${requestId}`);

  return (
    <main>
      <p>
        <Link href={`/providers/${id}/requests`}>Eşleşen talepler</Link>
      </p>
      <h1>{request.category.name}</h1>
      <p>Bu fazda teklif verme ve müşteri iletişim bilgileri aktif değildir.</p>
      <p>Bu fazda teklif kredisi kullanılmaz. Kredi sistemi sonraki fazda bağlanacaktır.</p>

      <section>
        <h2>Teklif</h2>
        {request.existingOffer ? (
          <p>
            Mevcut teklif: {request.existingOffer.priceAmount} TRY - {request.existingOffer.status} (
            {formatDate(request.existingOffer.submittedAt)})
          </p>
        ) : (
          <form action={createOfferAction}>
            <input type="hidden" name="providerId" value={id} />
            <input type="hidden" name="requestId" value={requestId} />
            <p>
              <label>
                Fiyat *
                <input name="priceAmount" type="number" min="1" required />
              </label>
            </p>
            <p>
              <label>
                Para birimi
                <input name="currency" defaultValue="TRY" />
              </label>
            </p>
            <p>
              <label>
                Tahmini başlangıç
                <input name="estimatedStartDate" type="date" />
              </label>
            </p>
            <p>
              <label>
                Tahmini bitiş
                <input name="estimatedCompletionDate" type="date" />
              </label>
            </p>
            <p>
              <label>
                Mesaj *
                <textarea name="message" required />
              </label>
            </p>
            <p>
              <label>
                Garanti notu
                <textarea name="warrantyNote" />
              </label>
            </p>
            <p>
              <label>
                İç not
                <textarea name="internalNote" />
              </label>
            </p>
            <button type="submit">Teklif Gönder</button>
          </form>
        )}
      </section>

      <section>
        <h2>Özet</h2>
        <p>
          Konum: {request.city}/{request.district}
          {request.neighborhood ? `/${request.neighborhood}` : ''}
        </p>
        <p>Adres notu: {request.addressNote ?? '-'}</p>
        <p>Bütçe: {formatBudget(request.budgetMin, request.budgetMax)}</p>
        <p>Tercih edilen tarih: {request.preferredDate ? formatDate(request.preferredDate) : '-'}</p>
        <p>Aciliyet: {request.urgency ?? '-'}</p>
        <p>Açıklama: {request.description ?? '-'}</p>
        <p>
          Kalite: {request.qualityScore}/100 - {request.qualityLabel}
        </p>
      </section>

      <section>
        <h2>Kalite Kırılımı</h2>
        <table>
          <thead>
            <tr>
              <th>Bileşen</th>
              <th>Puan</th>
              <th>Maksimum</th>
              <th>Geçti</th>
            </tr>
          </thead>
          <tbody>{renderBreakdownRows(request.qualityScoreBreakdown)}</tbody>
        </table>
      </section>

      <section>
        <h2>Dinamik Yanıtlar</h2>
        <table>
          <thead>
            <tr>
              <th>Soru</th>
              <th>Tip</th>
              <th>Yanıt</th>
            </tr>
          </thead>
          <tbody>
            {request.answers.map((answer) => (
              <tr key={answer.id}>
                <td>{answer.questionLabel}</td>
                <td>{answer.questionType}</td>
                <td>{formatValue(answer.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

function renderBreakdownRows(breakdown: Record<string, RequestQualityBreakdownComponent> | null) {
  if (!breakdown) {
    return (
      <tr>
        <td colSpan={4}>Kırılım kaydı yok.</td>
      </tr>
    );
  }

  return Object.entries(breakdown).map(([key, component]) => (
    <tr key={key}>
      <td>{key}</td>
      <td>{component.points}</td>
      <td>{component.max}</td>
      <td>{component.passed ? 'Evet' : 'Hayır'}</td>
    </tr>
  ));
}

function formatBudget(min: number | null, max: number | null) {
  if (min !== null && max !== null) {
    return `${min} - ${max}`;
  }

  return String(min ?? max ?? '-');
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatValue(value: unknown) {
  if (Array.isArray(value)) {
    return value.join(', ');
  }

  if (typeof value === 'boolean') {
    return value ? 'Evet' : 'Hayır';
  }

  if (value === null || value === undefined) {
    return '-';
  }

  return String(value);
}
