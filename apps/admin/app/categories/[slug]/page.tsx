import Link from 'next/link';
import {
  createQuestionAction,
  updateCategoryAction,
  updateCategoryStatusAction,
  updateQuestionAction,
  updateQuestionStatusAction,
} from '../actions';
import { apiFetch, Category, Question, QuestionOption, QuestionType, requireAdmin } from '../../../lib/api';

const questionTypes: QuestionType[] = [
  'TEXT',
  'TEXTAREA',
  'SELECT',
  'MULTI_SELECT',
  'NUMBER',
  'BOOLEAN',
  'DATE',
  'IMAGE',
];

type CategoryDetailPageProps = {
  params: Promise<{ slug: string }>;
};

export default async function CategoryDetailPage({ params }: CategoryDetailPageProps) {
  await requireAdmin();
  const { slug } = await params;
  const category = await apiFetch<Category>(`/categories/${slug}?includeInactive=true`);
  const questions = await apiFetch<Question[]>(`/categories/${category.id}/questions`);

  return (
    <main>
      <p className="breadcrumbs">
        <Link href="/">Dashboard</Link>
        <span aria-hidden="true">/</span>
        <Link href="/categories">Kategoriler</Link>
        <span aria-hidden="true">/</span>
        <span>{category.name}</span>
      </p>

      <header className="page-header">
        <h1 className="page-title">{category.name}</h1>
        <p className="page-subtitle">
          <span className={category.isActive ? 'badge badge-good' : 'badge badge-muted'}>
            {category.isActive ? 'Aktif' : 'Pasif'}
          </span>{' '}
          <span className="muted">· /{category.slug}</span>
        </p>
      </header>

      <section className="card">
        <h2>Kategori Bilgileri</h2>
        <form action={updateCategoryAction} className="form-card" style={{ maxWidth: 'none' }}>
          <input type="hidden" name="id" value={category.id} />
          <div className="form-grid">
            <label className="form-row">
              <span>İsim *</span>
              <input name="name" required defaultValue={category.name} />
            </label>
            <label className="form-row">
              <span>Slug *</span>
              <input
                name="slug"
                required
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                defaultValue={category.slug}
              />
            </label>
            <label className="form-row">
              <span>Sıralama</span>
              <input name="sortOrder" type="number" min="0" defaultValue={category.sortOrder} />
            </label>
          </div>
          <label className="form-row">
            <span>Açıklama</span>
            <textarea name="description" defaultValue={category.description ?? ''} />
          </label>
          <input type="hidden" name="isActive" value={String(category.isActive)} />
          <div className="form-actions" style={{ borderTop: 0, paddingTop: 0 }}>
            <button className="btn btn-primary" type="submit">Kategoriyi kaydet</button>
            <form action={updateCategoryStatusAction} style={{ display: 'inline' }}>
              <input type="hidden" name="id" value={category.id} />
              <input type="hidden" name="slug" value={category.slug} />
              <input type="hidden" name="isActive" value={String(!category.isActive)} />
              <button
                className={category.isActive ? 'btn btn-danger' : 'btn btn-secondary'}
                type="submit"
              >
                {category.isActive ? 'Pasifleştir' : 'Aktifleştir'}
              </button>
            </form>
          </div>
        </form>
      </section>

      <section>
        <h2 style={{ fontSize: 18 }}>Sorular</h2>
        <div className="list-stack">
          {questions.map((question) => (
            <article className="list-card" key={question.id}>
              <div className="list-card-header">
                <div>
                  <h3 className="list-card-title">{question.label}</h3>
                  <p className="list-card-meta">
                    <span>Key: <code style={{ fontSize: 12 }}>{question.key}</code></span>
                    <span>Tip: {question.type}</span>
                    <span>{question.isRequired ? 'Zorunlu' : 'Opsiyonel'}</span>
                  </p>
                </div>
                <span className={question.isActive ? 'badge badge-good' : 'badge badge-muted'}>
                  {question.isActive ? 'Aktif' : 'Pasif'}
                </span>
              </div>
              <form action={updateQuestionAction} className="form-card" style={{ maxWidth: 'none' }}>
                <input type="hidden" name="id" value={question.id} />
                <input type="hidden" name="categorySlug" value={category.slug} />
                <QuestionFields question={question} />
                <div className="form-actions" style={{ borderTop: 0, paddingTop: 0 }}>
                  <button className="btn btn-primary btn-sm" type="submit">Soruyu kaydet</button>
                </div>
              </form>
              <form action={updateQuestionStatusAction}>
                <input type="hidden" name="id" value={question.id} />
                <input type="hidden" name="categorySlug" value={category.slug} />
                <input type="hidden" name="isActive" value={String(!question.isActive)} />
                <button
                  className={question.isActive ? 'btn btn-danger btn-sm' : 'btn btn-secondary btn-sm'}
                  type="submit"
                >
                  {question.isActive ? 'Pasifleştir' : 'Aktifleştir'}
                </button>
              </form>
            </article>
          ))}
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 18 }}>Yeni Soru Ekle</h2>
        <form action={createQuestionAction} className="form-card">
          <section className="form-section">
            <h2>Soru Bilgileri</h2>
            <input type="hidden" name="categoryId" value={category.id} />
            <input type="hidden" name="categorySlug" value={category.slug} />
            <QuestionFields />
          </section>
          <div className="form-actions">
            <button className="btn btn-primary" type="submit">Soruyu oluştur</button>
          </div>
        </form>
      </section>
    </main>
  );
}

function QuestionFields({ question }: { question?: Question }) {
  return (
    <>
      <div className="form-grid">
        <label className="form-row">
          <span>Anahtar</span>
          <input
            name="key"
            required
            pattern="[a-z0-9]+([_-][a-z0-9]+)*"
            defaultValue={question?.key ?? ''}
          />
        </label>
        <label className="form-row">
          <span>Etiket</span>
          <input name="label" required defaultValue={question?.label ?? ''} />
        </label>
        <label className="form-row">
          <span>Tip</span>
          <select name="type" defaultValue={question?.type ?? 'TEXT'}>
            {questionTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className="form-row">
          <span>Zorunlu</span>
          <select name="isRequired" defaultValue={String(question?.isRequired ?? false)}>
            <option value="false">Hayır</option>
            <option value="true">Evet</option>
          </select>
        </label>
        <label className="form-row">
          <span>Sıralama</span>
          <input name="sortOrder" type="number" min="0" defaultValue={question?.sortOrder ?? 0} />
        </label>
      </div>
      <label className="form-row">
        <span>Yardım metni</span>
        <input name="helpText" defaultValue={question?.helpText ?? ''} />
      </label>
      <label className="form-row">
        <span>Seçenekler (JSON)</span>
        <textarea name="options" defaultValue={formatOptions(question?.options)} />
        <span className="help-text">SELECT / MULTI_SELECT tipleri için anahtar/etiket çiftleri JSON.</span>
      </label>
      <input type="hidden" name="isActive" value={String(question?.isActive ?? true)} />
    </>
  );
}

function formatOptions(options: QuestionOption[] | null | undefined) {
  return options ? JSON.stringify(options, null, 2) : '';
}
