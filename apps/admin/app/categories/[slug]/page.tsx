import Link from 'next/link';
import {
  createQuestionAction,
  updateCategoryAction,
  updateCategoryStatusAction,
  updateQuestionAction,
  updateQuestionStatusAction,
} from '../actions';
import { apiFetch, Category, Question, QuestionOption, QuestionType } from '../../../lib/api';

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
  const { slug } = await params;
  const category = await apiFetch<Category>(`/categories/${slug}?includeInactive=true`);
  const questions = await apiFetch<Question[]>(`/categories/${category.id}/questions`);

  return (
    <main>
      <p>
        <Link href="/categories">Back to categories</Link>
      </p>
      <h1>{category.name}</h1>
      <section>
        <h2>Category</h2>
        <form action={updateCategoryAction}>
          <input type="hidden" name="id" value={category.id} />
          <p>
            <label>
              Name
              <input name="name" required defaultValue={category.name} />
            </label>
          </p>
          <p>
            <label>
              Slug
              <input
                name="slug"
                required
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                defaultValue={category.slug}
              />
            </label>
          </p>
          <p>
            <label>
              Description
              <textarea name="description" defaultValue={category.description ?? ''} />
            </label>
          </p>
          <p>
            <label>
              Sort order
              <input name="sortOrder" type="number" min="0" defaultValue={category.sortOrder} />
            </label>
          </p>
          <input type="hidden" name="isActive" value={String(category.isActive)} />
          <button type="submit">Save category</button>
        </form>
        <form action={updateCategoryStatusAction}>
          <input type="hidden" name="id" value={category.id} />
          <input type="hidden" name="slug" value={category.slug} />
          <input type="hidden" name="isActive" value={String(!category.isActive)} />
          <button type="submit">{category.isActive ? 'Deactivate' : 'Activate'} category</button>
        </form>
      </section>

      <section>
        <h2>Questions</h2>
        {questions.map((question) => (
          <form key={question.id} action={updateQuestionAction}>
            <fieldset>
              <legend>
                {question.label} ({question.isActive ? 'active' : 'inactive'})
              </legend>
              <input type="hidden" name="id" value={question.id} />
              <input type="hidden" name="categorySlug" value={category.slug} />
              <QuestionFields question={question} />
              <button type="submit">Save question</button>
            </fieldset>
          </form>
        ))}
        {questions.map((question) => (
          <form key={`${question.id}-status`} action={updateQuestionStatusAction}>
            <input type="hidden" name="id" value={question.id} />
            <input type="hidden" name="categorySlug" value={category.slug} />
            <input type="hidden" name="isActive" value={String(!question.isActive)} />
            <button type="submit">{question.isActive ? 'Deactivate' : 'Activate'} {question.key}</button>
          </form>
        ))}
      </section>

      <section>
        <h2>Create Question</h2>
        <form action={createQuestionAction}>
          <input type="hidden" name="categoryId" value={category.id} />
          <input type="hidden" name="categorySlug" value={category.slug} />
          <QuestionFields />
          <button type="submit">Create question</button>
        </form>
      </section>
    </main>
  );
}

function QuestionFields({ question }: { question?: Question }) {
  return (
    <>
      <p>
        <label>
          Key
          <input
            name="key"
            required
            pattern="[a-z0-9]+([_-][a-z0-9]+)*"
            defaultValue={question?.key ?? ''}
          />
        </label>
      </p>
      <p>
        <label>
          Label
          <input name="label" required defaultValue={question?.label ?? ''} />
        </label>
      </p>
      <p>
        <label>
          Help text
          <input name="helpText" defaultValue={question?.helpText ?? ''} />
        </label>
      </p>
      <p>
        <label>
          Type
          <select name="type" defaultValue={question?.type ?? 'TEXT'}>
            {questionTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
      </p>
      <p>
        <label>
          Required
          <select name="isRequired" defaultValue={String(question?.isRequired ?? false)}>
            <option value="false">No</option>
            <option value="true">Yes</option>
          </select>
        </label>
      </p>
      <p>
        <label>
          Sort order
          <input name="sortOrder" type="number" min="0" defaultValue={question?.sortOrder ?? 0} />
        </label>
      </p>
      <p>
        <label>
          Options JSON
          <textarea name="options" defaultValue={formatOptions(question?.options)} />
        </label>
      </p>
      <input type="hidden" name="isActive" value={String(question?.isActive ?? true)} />
    </>
  );
}

function formatOptions(options: QuestionOption[] | null | undefined) {
  return options ? JSON.stringify(options, null, 2) : '';
}
