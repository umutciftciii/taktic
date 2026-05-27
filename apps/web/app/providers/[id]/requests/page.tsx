import Link from 'next/link';
import { apiFetch, Category, ProviderProfile, ProviderRequestListItem } from '../../../../lib/api';

type ProviderRequestsPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    categoryId?: string;
    city?: string;
    district?: string;
    minQualityScore?: string;
  }>;
};

export default async function ProviderRequestsPage({ params, searchParams }: ProviderRequestsPageProps) {
  const { id } = await params;
  const filters = await searchParams;
  const [provider, categories] = await Promise.all([
    apiFetch<ProviderProfile>(`/providers/${id}`),
    apiFetch<Category[]>('/categories'),
  ]);

  let requests: ProviderRequestListItem[] = [];
  let errorMessage: string | null = null;

  try {
    requests = await apiFetch<ProviderRequestListItem[]>(`/providers/${id}/requests${toQueryString(filters)}`);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Talepler yüklenemedi';
  }

  return (
    <main>
      <p>
        <Link href={`/providers/${id}`}>Provider profile</Link>
      </p>
      <h1>Eşleşen Talepler</h1>
      <p>
        Bu geliştirme akışında provider id URL içinde kalır, fakat hassas provider işlemleri oturum ve sahiplik
        kontrolünden geçer.
      </p>
      <p>
        Provider: {provider.businessName} ({provider.status})
      </p>

      <form>
        <p>
          <label>
            Kategori
            <select name="categoryId" defaultValue={filters.categoryId ?? ''}>
              <option value="">Tümü</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
        </p>
        <p>
          <label>
            İl
            <input name="city" defaultValue={filters.city ?? ''} />
          </label>
        </p>
        <p>
          <label>
            İlçe
            <input name="district" defaultValue={filters.district ?? ''} />
          </label>
        </p>
        <p>
          <label>
            Minimum kalite skoru
            <input name="minQualityScore" type="number" min="0" max="100" defaultValue={filters.minQualityScore ?? ''} />
          </label>
        </p>
        <button type="submit">Filtrele</button>
      </form>

      {errorMessage ? <p>{errorMessage}</p> : null}
      {!errorMessage && requests.length === 0 ? <p>Eşleşen onaylı talep bulunamadı.</p> : null}
      {requests.map((request) => (
        <article key={request.id}>
          <h2>{request.category.name}</h2>
          <p>
            Konum: {request.city}/{request.district}
            {request.neighborhood ? `/${request.neighborhood}` : ''}
          </p>
          <p>Bütçe: {formatBudget(request.budgetMin, request.budgetMax)}</p>
          <p>Aciliyet: {request.urgency ?? '-'}</p>
          <p>
            Kalite: {request.qualityScore}/100 - {request.qualityLabel}
          </p>
          <p>Yanıt sayısı: {request.answersCount}</p>
          <p>Gönderim: {formatDate(request.submittedAt)}</p>
          <p>
            <Link href={`/providers/${id}/requests/${request.id}`}>Detay</Link>
          </p>
        </article>
      ))}
    </main>
  );
}

function toQueryString(filters: Record<string, string | undefined>) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value) {
      params.set(key, value);
    }
  }

  const query = params.toString();
  return query ? `?${query}` : '';
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
