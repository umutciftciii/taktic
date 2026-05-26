import Link from 'next/link';
import { apiFetch, Category } from '../../lib/api';

export default async function CategoriesPage() {
  const categories = await apiFetch<Category[]>('/categories');

  return (
    <main>
      <h1>Hizmet Kategorileri</h1>
      <ul>
        {categories.map((category) => (
          <li key={category.id}>
            <Link href={`/categories/${category.slug}`}>{category.name}</Link>
            {category.description ? <p>{category.description}</p> : null}
          </li>
        ))}
      </ul>
    </main>
  );
}
