import Link from 'next/link';
import { apiFetch, Category, ProviderProfile } from '../../../../lib/api';
import { updateProviderAction } from '../../actions';

type ProviderEditPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProviderEditPage({ params }: ProviderEditPageProps) {
  const { id } = await params;
  const [provider, categories] = await Promise.all([
    apiFetch<ProviderProfile>(`/providers/${id}`),
    apiFetch<Category[]>('/categories'),
  ]);
  const selectedCategoryIds = new Set(provider.serviceCategories.map((item) => item.category.id));
  const firstArea = provider.serviceAreas[0];

  return (
    <main>
      <p>
        <Link href={`/providers/${provider.id}`}>Profile dön</Link>
      </p>
      <h1>Profil Düzenle</h1>
      <form action={updateProviderAction}>
        <input type="hidden" name="id" value={provider.id} />
        <p>
          <label>
            İşletme adı *
            <input name="businessName" required defaultValue={provider.businessName} />
          </label>
        </p>
        <p>
          <label>
            Yetkili kişi *
            <input name="contactName" required defaultValue={provider.contactName} />
          </label>
        </p>
        <p>
          <label>
            Telefon *
            <input name="phone" required defaultValue={provider.phone} />
          </label>
        </p>
        <p>
          <label>
            E-posta
            <input name="email" type="email" defaultValue={provider.email ?? ''} />
          </label>
        </p>
        <p>
          <label>
            İl *
            <input name="city" required defaultValue={provider.city} />
          </label>
        </p>
        <p>
          <label>
            İlçe *
            <input name="district" required defaultValue={provider.district} />
          </label>
        </p>
        <p>
          <label>
            Adres notu
            <textarea name="addressNote" defaultValue={provider.addressNote ?? ''} />
          </label>
        </p>
        <p>
          <label>
            Açıklama
            <textarea name="description" defaultValue={provider.description ?? ''} />
          </label>
        </p>

        <h2>Kategoriler</h2>
        {categories.map((category) => (
          <p key={category.id}>
            <label>
              <input
                name="categoryIds"
                type="checkbox"
                value={category.id}
                defaultChecked={selectedCategoryIds.has(category.id)}
              />{' '}
              {category.name}
            </label>
          </p>
        ))}

        <h2>Hizmet Bölgesi</h2>
        <p>
          <label>
            İl *
            <input name="serviceAreaCity" required defaultValue={firstArea?.city ?? provider.city} />
          </label>
        </p>
        <p>
          <label>
            İlçe
            <input name="serviceAreaDistrict" defaultValue={firstArea?.district ?? provider.district} />
          </label>
        </p>
        <p>
          <label>
            Mahalle
            <input name="serviceAreaNeighborhood" defaultValue={firstArea?.neighborhood ?? ''} />
          </label>
        </p>

        <button type="submit">Profili Kaydet</button>
      </form>
    </main>
  );
}
