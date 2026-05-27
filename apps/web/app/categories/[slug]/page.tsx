import Link from 'next/link';
import { apiFetch, Category, getCurrentUser, Question } from '../../../lib/api';
import { submitServiceRequestAction } from '../actions';

type CategoryPageProps = {
  params: Promise<{ slug: string }>;
};

export default async function CategoryPage({ params }: CategoryPageProps) {
  const { slug } = await params;
  const [category, user] = await Promise.all([
    apiFetch<Category>(`/categories/${slug}`),
    getCurrentUser(),
  ]);
  const questions = category.questions ?? [];

  return (
    <main>
      <p>
        <Link href="/categories">Tum kategoriler</Link>
      </p>
      <h1>{category.name}</h1>
      {category.description ? <p>{category.description}</p> : null}
      {user?.role === 'CUSTOMER' ? (
        <p>Bu talep müşteri hesabınıza bağlanacak.</p>
      ) : (
        <p>Misafir talep oluşturuyorsunuz. Hesap oluşturursanız taleplerinizi daha sonra takip edebilirsiniz.</p>
      )}
      <form action={submitServiceRequestAction}>
        <input type="hidden" name="categorySlug" value={category.slug} />
        <input
          type="hidden"
          name="questionMeta"
          value={JSON.stringify(questions.map((question) => ({ key: question.key, type: question.type })))}
        />
        <section>
          <h2>Talep Detaylari</h2>
        {questions.map((question) => (
          <RequestField key={question.id} question={question} />
        ))}
        </section>

        <section>
          <h2>Iletisim ve Konum</h2>
          <p>
            <label>
              Ad soyad *
              <input name="customerName" required />
            </label>
          </p>
          <p>
            <label>
              Telefon *
              <input name="customerPhone" required />
            </label>
          </p>
          <p>
            <label>
              E-posta
              <input name="customerEmail" type="email" />
            </label>
          </p>
          <p>
            <label>
              Il *
              <input name="city" required />
            </label>
          </p>
          <p>
            <label>
              Ilce *
              <input name="district" required />
            </label>
          </p>
          <p>
            <label>
              Mahalle
              <input name="neighborhood" />
            </label>
          </p>
          <p>
            <label>
              Adres notu
              <textarea name="addressNote" />
            </label>
          </p>
        </section>

        <section>
          <h2>Ek Bilgiler</h2>
          <p>
            <label>
              Minimum butce
              <input name="budgetMin" type="number" min="0" />
            </label>
          </p>
          <p>
            <label>
              Maksimum butce
              <input name="budgetMax" type="number" min="0" />
            </label>
          </p>
          <p>
            <label>
              Tercih edilen tarih
              <input name="preferredDate" type="date" />
            </label>
          </p>
          <p>
            <label>
              Aciliyet
              <select name="urgency">
                <option value="">Seciniz</option>
                <option value="TODAY">Bugun</option>
                <option value="THIS_WEEK">Bu hafta</option>
                <option value="FLEXIBLE">Esnek</option>
              </select>
            </label>
          </p>
          <p>
            <label>
              Aciklama
              <textarea name="description" />
            </label>
          </p>
        </section>

        <button type="submit">Talep Gonder</button>
      </form>
    </main>
  );
}

function RequestField({ question }: { question: Question }) {
  return (
    <p>
      <label>
        {question.label}
        {question.isRequired ? ' *' : ''}
        {renderInput(question)}
      </label>
      {question.helpText ? <small>{question.helpText}</small> : null}
    </p>
  );
}

function renderInput(question: Question) {
  const name = `answer_${question.key}`;

  switch (question.type) {
    case 'TEXT':
      return <input name={name} required={question.isRequired} />;
    case 'TEXTAREA':
      return <textarea name={name} required={question.isRequired} />;
    case 'SELECT':
      return (
        <select name={name} required={question.isRequired}>
          <option value="">Seciniz</option>
          {(question.options ?? []).map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      );
    case 'MULTI_SELECT':
      return (
        <select name={name} multiple required={question.isRequired}>
          {(question.options ?? []).map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      );
    case 'NUMBER':
      return <input name={name} type="number" required={question.isRequired} />;
    case 'BOOLEAN':
      return <input name={name} type="checkbox" value="true" />;
    case 'DATE':
      return <input name={name} type="date" required={question.isRequired} />;
    case 'IMAGE':
      return <input name={name} placeholder="Dosya yukleme sonraki fazda" required={question.isRequired} />;
  }
}
