import Link from 'next/link';
import { apiFetch, Category, requireAdmin } from '../../lib/api';

export default async function AdminCategoriesPage() {
  await requireAdmin();
  const categories = await apiFetch<Category[]>('/categories?includeInactive=true');

  return (
    <main>
      <h1>Categories</h1>
      <p>Manage service categories and their dynamic request questions.</p>
      <p>
        <Link href="/categories/new">Create category</Link>
      </p>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Slug</th>
            <th>Status</th>
            <th>Sort</th>
            <th>Questions</th>
          </tr>
        </thead>
        <tbody>
          {categories.map((category) => (
            <tr key={category.id}>
              <td>
                <Link href={`/categories/${category.slug}`}>{category.name}</Link>
              </td>
              <td>{category.slug}</td>
              <td>{category.isActive ? 'Active' : 'Inactive'}</td>
              <td>{category.sortOrder}</td>
              <td>{category._count?.questions ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
