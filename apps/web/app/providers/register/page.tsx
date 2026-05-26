import Link from 'next/link';
import { apiFetch, Category } from '../../../lib/api';
import { createProviderAction } from '../actions';

export default async function ProviderRegisterPage() {
  const categories = await apiFetch<Category[]>('/categories');

  return (
    <main>
      <p>
        <Link href="/">Ana sayfa</Link>
      </p>
      <h1>Hizmet Veren Başvurusu</h1>
      <form action={createProviderAction}>
        <section>
          <h2>İşletme Bilgileri</h2>
          <p>
            <label>
              İşletme adı *
              <input name="businessName" required />
            </label>
          </p>
          <p>
            <label>
              Yetkili kişi *
              <input name="contactName" required />
            </label>
          </p>
          <p>
            <label>
              Telefon *
              <input name="phone" required />
            </label>
          </p>
          <p>
            <label>
              E-posta
              <input name="email" type="email" />
            </label>
          </p>
          <p>
            <label>
              İl *
              <input name="city" required />
            </label>
          </p>
          <p>
            <label>
              İlçe *
              <input name="district" required />
            </label>
          </p>
          <p>
            <label>
              Adres notu
              <textarea name="addressNote" />
            </label>
          </p>
          <p>
            <label>
              Açıklama
              <textarea name="description" />
            </label>
          </p>
        </section>

        <section>
          <h2>Hizmet Kategorileri</h2>
          {categories.map((category) => (
            <p key={category.id}>
              <label>
                <input name="categoryIds" type="checkbox" value={category.id} /> {category.name}
              </label>
            </p>
          ))}
        </section>

        <section>
          <h2>Hizmet Bölgesi</h2>
          <p>
            <label>
              İl *
              <input name="serviceAreaCity" required />
            </label>
          </p>
          <p>
            <label>
              İlçe
              <input name="serviceAreaDistrict" />
            </label>
          </p>
          <p>
            <label>
              Mahalle
              <input name="serviceAreaNeighborhood" />
            </label>
          </p>
        </section>

        <button type="submit">Başvuruyu Gönder</button>
      </form>
    </main>
  );
}
