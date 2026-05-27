import Link from 'next/link';
import { apiFetch, Category } from '../../lib/api';

export default async function CategoriesPage() {
  const categories = await apiFetch<Category[]>('/categories');

  return (
    <main>
      <h1>Hizmet Kategorileri</h1>
      <section className="card-grid">
        {categories.map((category) => (
          <article className="card" key={category.id}>
            <h2><Link href={`/categories/${category.slug}`}>{category.name}</Link></h2>
            {category.description ? <p>{category.description}</p> : null}
            <Link className="button" href={`/categories/${category.slug}`}>Talep oluştur</Link>
          </article>
        ))}
      </section>
    </main>
  );
}
