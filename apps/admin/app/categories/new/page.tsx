import Link from 'next/link';
import { createCategoryAction } from '../actions';
import { requireAdmin } from '../../../lib/api';

export default async function NewCategoryPage() {
  await requireAdmin();

  return (
    <main>
      <p>
        <Link href="/categories">Back to categories</Link>
      </p>
      <h1>Create Category</h1>
      <form action={createCategoryAction}>
        <p>
          <label>
            Name
            <input name="name" required />
          </label>
        </p>
        <p>
          <label>
            Slug
            <input name="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" />
          </label>
        </p>
        <p>
          <label>
            Description
            <textarea name="description" />
          </label>
        </p>
        <p>
          <label>
            Sort order
            <input name="sortOrder" type="number" min="0" defaultValue="0" />
          </label>
        </p>
        <input type="hidden" name="isActive" value="true" />
        <button type="submit">Create</button>
      </form>
    </main>
  );
}
