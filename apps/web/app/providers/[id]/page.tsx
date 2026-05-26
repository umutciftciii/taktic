import Link from 'next/link';
import { apiFetch, ProviderProfile } from '../../../lib/api';

type ProviderPreviewPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProviderPreviewPage({ params }: ProviderPreviewPageProps) {
  const { id } = await params;
  const provider = await apiFetch<ProviderProfile>(`/providers/${id}`);

  return (
    <main>
      <p>
        <Link href="/">Ana sayfa</Link>
      </p>
      <h1>{provider.businessName}</h1>
      <p>
        <Link href={`/providers/${provider.id}/edit`}>Profili düzenle</Link>
      </p>
      {provider.status === 'APPROVED' ? (
        <p>
          <Link href={`/providers/${provider.id}/requests`}>Eşleşen talepleri görüntüle</Link>
        </p>
      ) : null}
      <p>Durum: {provider.status}</p>
      <p>Yetkili: {provider.contactName}</p>
      <p>Telefon: {provider.phone}</p>
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
