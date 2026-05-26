import Link from 'next/link';
import { apiFetch, Category, Question } from '../../../lib/api';

type CategoryPageProps = {
  params: Promise<{ slug: string }>;
};

export default async function CategoryPage({ params }: CategoryPageProps) {
  const { slug } = await params;
  const category = await apiFetch<Category>(`/categories/${slug}`);
  const questions = category.questions ?? [];

  return (
    <main>
      <p>
        <Link href="/categories">Tum kategoriler</Link>
      </p>
      <h1>{category.name}</h1>
      {category.description ? <p>{category.description}</p> : null}
      <p>Bu fazda talep gönderimi aktif değildir. Bu ekran dinamik form önizlemesidir.</p>
      <form>
        {questions.map((question) => (
          <FieldPreview key={question.id} question={question} />
        ))}
      </form>
    </main>
  );
}

function FieldPreview({ question }: { question: Question }) {
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
  switch (question.type) {
    case 'TEXT':
      return <input name={question.key} disabled />;
    case 'TEXTAREA':
      return <textarea name={question.key} disabled />;
    case 'SELECT':
      return (
        <select name={question.key} disabled>
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
        <select name={question.key} multiple disabled>
          {(question.options ?? []).map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      );
    case 'NUMBER':
      return <input name={question.key} type="number" disabled />;
    case 'BOOLEAN':
      return <input name={question.key} type="checkbox" disabled />;
    case 'DATE':
      return <input name={question.key} type="date" disabled />;
    case 'IMAGE':
      return <input name={question.key} type="file" disabled />;
  }
}
