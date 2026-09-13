import type { Question } from '../../lib/api';

/**
 * One category question, rendered as the input its type calls for.
 *
 * Shared by the marketplace form and the vitrin card's form, because the
 * questions are the category's and not the form's: a card is published for
 * one category, and a lead on it has to answer what that category requires
 * or the API refuses it exactly as it would refuse a marketplace request.
 *
 * The field name is `answer_<key>`; the form's `questionMeta` field lists the
 * keys and types that were rendered, and the server action reads the answers
 * back through the same convention.
 */
export function RequestField({
  question,
  defaultValue,
}: {
  question: Question;
  /** A saved draft's answer for this question, when one is being restored. */
  defaultValue?: unknown;
}) {
  return (
    <label className="form-row">
      <span>
        {question.label}
        {question.isRequired ? ' *' : ''}
      </span>
      {renderInput(question, defaultValue)}
      {question.helpText ? <span className="help-text">{question.helpText}</span> : null}
    </label>
  );
}

/** Whether a draft value can fill a text/select control's `defaultValue`. */
function isTextualDefault(value: unknown): value is string | number {
  return typeof value === 'string' || typeof value === 'number';
}

function renderInput(question: Question, defaultValue?: unknown) {
  const name = `answer_${question.key}`;
  const textDefault = isTextualDefault(defaultValue) ? String(defaultValue) : undefined;

  switch (question.type) {
    case 'TEXT':
      return <input name={name} required={question.isRequired} defaultValue={textDefault} />;
    case 'TEXTAREA':
      return <textarea name={name} required={question.isRequired} defaultValue={textDefault} />;
    case 'SELECT':
      return (
        <select name={name} required={question.isRequired} defaultValue={textDefault ?? ''}>
          <option value="">Seçiniz</option>
          {(question.options ?? []).map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      );
    case 'MULTI_SELECT':
      return (
        <select
          name={name}
          multiple
          required={question.isRequired}
          defaultValue={Array.isArray(defaultValue) ? (defaultValue as string[]) : undefined}
        >
          {(question.options ?? []).map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      );
    case 'NUMBER':
      return <input name={name} type="number" required={question.isRequired} defaultValue={textDefault} />;
    case 'BOOLEAN':
      return (
        <span className="checkbox-row">
          <input
            name={name}
            type="checkbox"
            value="true"
            defaultChecked={defaultValue === true || defaultValue === 'true'}
          />
          <span>Evet</span>
        </span>
      );
    case 'DATE':
      return <input name={name} type="date" required={question.isRequired} defaultValue={textDefault} />;
    case 'IMAGE':
      return (
        <input
          name={name}
          placeholder="Dosya yükleme sonraki fazda"
          required={question.isRequired}
          defaultValue={textDefault}
        />
      );
  }
}

/**
 * The `questionMeta` field's value: which questions the form rendered, so the
 * server action knows which `answer_*` fields to read and how to type them.
 * Only the questions on screen — a hidden one carries no answer, and the API
 * refuses one that arrives anyway.
 */
export function encodeQuestionMeta(questions: readonly Question[]): string {
  return JSON.stringify(questions.map((question) => ({ key: question.key, type: question.type })));
}

/**
 * Reads what the rendered questions currently hold, keyed by question key —
 * the input conditional visibility needs to decide which questions to show.
 */
export function readAnswers(
  form: HTMLFormElement,
  questions: readonly Question[],
): Record<string, string | string[]> {
  const answers: Record<string, string | string[]> = {};

  for (const question of questions) {
    if (question.systemField) {
      continue;
    }

    const element = form.elements.namedItem(`answer_${question.key}`);

    if (element instanceof HTMLSelectElement && element.multiple) {
      answers[question.key] = Array.from(element.selectedOptions).map((option) => option.value);
    } else if (element instanceof HTMLInputElement && element.type === 'checkbox') {
      answers[question.key] = element.checked ? 'true' : 'false';
    } else if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      answers[question.key] = element.value;
    }
  }

  return answers;
}
