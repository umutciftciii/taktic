import Link from 'next/link';
import { apiFetch, ProviderProfile, statusLabel } from '../../../lib/api';

type ProviderPreviewPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProviderPreviewPage({ params }: ProviderPreviewPageProps) {
  const { id } = await params;
  const provider = await apiFetch<ProviderProfile>(`/providers/${id}`);

  return (
    <main>
      <p>
        <Link href="/providers/me">Panelim</Link> <Link href="/">Ana sayfa</Link>
      </p>
      <h1>{provider.businessName}</h1>
      <p><span className={badgeClass(provider.status)}>{statusLabel(provider.status)}</span></p>
      {provider.status === 'APPROVED' ? (
        <p className="actions">
          <Link className="button" href={`/providers/${provider.id}/requests`}>Uygun Talepler</Link>
          <Link className="button" href={`/providers/${provider.id}/offers`}>Tekliflerim</Link>
          <Link className="button" href={`/providers/${provider.id}/credits`}>Kredilerim</Link>
          <Link className="button" href={`/providers/${provider.id}/edit`}>Profili düzenle</Link>
        </p>
      ) : null}
      {provider.status !== 'APPROVED' ? (
        <p className="actions">
          <Link className="button" href={`/providers/${provider.id}/edit`}>Profili düzenle</Link>
        </p>
      ) : null}
      <p>Yetkili: {provider.contactName}</p>
      <p>
        Konum: {provider.city}/{provider.district}
      </p>
      <h2>Kategoriler</h2>
      <ul>
        {provider.serviceCategories.map((item) => (
          <li key={item.id}>{item.category.name}</li>
        ))}
      </ul>
      <h2>Hizmet Bölgeleri</h2>
      <ul>
        {provider.serviceAreas.map((area) => (
          <li key={area.id}>
            {area.city}
            {area.district ? `/${area.district}` : ''}
            {area.neighborhood ? `/${area.neighborhood}` : ''}
          </li>
        ))}
      </ul>
    </main>
  );
}

function badgeClass(status: string) {
  if (status === 'APPROVED') return 'badge badge-good';
  if (status === 'PENDING_REVIEW') return 'badge badge-warn';
  if (status === 'REJECTED' || status === 'SUSPENDED') return 'badge badge-bad';
  return 'badge';
}
