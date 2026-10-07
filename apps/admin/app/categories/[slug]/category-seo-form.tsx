'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  EDITORIAL_BLOCK_MAX,
  FAQ_ANSWER_MAX,
  FAQ_MAX_ITEMS,
  FAQ_QUESTION_MAX,
  SEO_DESCRIPTION_MAX,
  SEO_TITLE_MAX,
  type FaqItem,
} from '../../../lib/seo';
import { updateCategorySeoContentAction } from '../seo-actions';
import { CATEGORY_SEO_IDLE } from '../seo-content-state';

type CategorySeoFormProps = {
  categoryId: string;
  categorySlug: string;
  seoTitle: string | null;
  seoDescription: string | null;
  editorialDecisionGuide: string | null;
  editorialPriceFactors: string | null;
  editorialFaq: FaqItem[] | null;
  /** The index rule's per-block minimum, from the API's own evaluation. */
  blockMinChars: number | null;
};

/**
 * A category's search-engine content (SEO-004 PR B): the "Arama motoru" tab's
 * form, saved through `PATCH /admin/seo/categories/:id/content`
 * (SEO_CONTENT_WRITE) — its own route, apart from the category form.
 *
 * The counters are the API's limits (`category-seo-content.ts`): title 70,
 * description 160, each editorial block 6000, the FAQ 1–20 rows of a question
 * (200) and an answer (2000). They count what the field holds, which is what
 * the limit counts; the index rule counts letters and digits only, and the tab
 * says that beside its own numbers.
 *
 * An empty field is "not written" (NULL), never an empty string. A FAQ row
 * with only one half filled is refused by the API, and named here before it
 * gets there. A refusal keeps everything typed.
 */
export function CategorySeoForm(props: CategorySeoFormProps) {
  const [state, formAction] = useActionState(updateCategorySeoContentAction, CATEGORY_SEO_IDLE);
  const [title, setTitle] = useState(props.seoTitle ?? '');
  const [description, setDescription] = useState(props.seoDescription ?? '');
  const [guide, setGuide] = useState(props.editorialDecisionGuide ?? '');
  const [factors, setFactors] = useState(props.editorialPriceFactors ?? '');
  const [faq, setFaq] = useState<FaqItem[]>(props.editorialFaq ?? []);

  const halfRows = faq
    .map((item, index) => ({ index, half: Boolean(item.question.trim()) !== Boolean(item.answer.trim()) }))
    .filter((row) => row.half)
    .map((row) => row.index + 1);
  const tooLong =
    title.length > SEO_TITLE_MAX ||
    description.length > SEO_DESCRIPTION_MAX ||
    guide.length > EDITORIAL_BLOCK_MAX ||
    factors.length > EDITORIAL_BLOCK_MAX;
  const error = state.kind === 'error' ? state : null;

  function setFaqItem(index: number, patch: Partial<FaqItem>) {
    setFaq((rows) => rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  }

  return (
    <form action={formAction} className="compact-form compact-form-wide seo-content-form" data-testid="category-seo-form">
      <input type="hidden" name="categoryId" value={props.categoryId} />
      <input type="hidden" name="categorySlug" value={props.categorySlug} />
      {/* The FAQ travels as one JSON field: the action parses it and the API validates every row. */}
      <input type="hidden" name="editorialFaq" value={JSON.stringify(faq)} />

      <div className="compact-field-grid">
        <label className="field field-6">
          <span>
            SEO başlığı <Counter value={title.length} max={SEO_TITLE_MAX} testId="category-seo-title-count" />
          </span>
          <input
            name="seoTitle"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={SEO_TITLE_MAX}
            aria-invalid={error?.field === 'seoTitle' ? true : undefined}
            data-testid="category-seo-title"
          />
          <span className="help-text">Arama sonucunda görünen başlık. Boş bırakılırsa kategori adı kullanılır.</span>
        </label>
        <label className="field field-6">
          <span>
            SEO açıklaması{' '}
            <Counter value={description.length} max={SEO_DESCRIPTION_MAX} testId="category-seo-description-count" />
          </span>
          <textarea
            name="seoDescription"
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value.replace(/\r?\n/g, ' '))}
            maxLength={SEO_DESCRIPTION_MAX}
            aria-invalid={error?.field === 'seoDescription' ? true : undefined}
            data-testid="category-seo-description"
          />
          <span className="help-text">Arama sonucundaki kısa açıklama; tek satır. Boşsa kategori açıklamasından üretilir.</span>
        </label>
        <label className="field field-12">
          <span>
            Karar rehberi{' '}
            <Counter value={guide.length} max={EDITORIAL_BLOCK_MAX} min={props.blockMinChars} testId="category-seo-guide-count" />
          </span>
          <textarea
            name="editorialDecisionGuide"
            rows={6}
            value={guide}
            onChange={(event) => setGuide(event.target.value)}
            maxLength={EDITORIAL_BLOCK_MAX}
            aria-invalid={error?.field === 'editorialDecisionGuide' ? true : undefined}
            data-testid="category-seo-guide"
          />
          <span className="help-text">Müşterinin doğru hizmeti nasıl seçeceği. Kategori sayfasında “Nasıl seçilir” olarak görünür.</span>
        </label>
        <label className="field field-12">
          <span>
            Fiyatı etkileyen faktörler{' '}
            <Counter value={factors.length} max={EDITORIAL_BLOCK_MAX} min={props.blockMinChars} testId="category-seo-factors-count" />
          </span>
          <textarea
            name="editorialPriceFactors"
            rows={6}
            value={factors}
            onChange={(event) => setFactors(event.target.value)}
            maxLength={EDITORIAL_BLOCK_MAX}
            aria-invalid={error?.field === 'editorialPriceFactors' ? true : undefined}
            data-testid="category-seo-factors"
          />
          <span className="help-text">Fiyatı neyin artırıp azalttığı. Kategori sayfasında “Fiyatı neler etkiler” olarak görünür.</span>
        </label>
      </div>

      <fieldset className="seo-faq" data-testid="category-seo-faq">
        <legend>
          Sık sorulan sorular{' '}
          <span className="seo-counter" data-testid="category-seo-faq-count">
            {faq.length} / {FAQ_MAX_ITEMS}
          </span>
        </legend>
        {faq.length === 0 ? (
          <p className="help-text" data-testid="category-seo-faq-empty">
            Henüz soru yok. Kategori sayfasında SSS bölümü görünmez ve arama motoru içerik bloğu eksik sayılır.
          </p>
        ) : null}
        <ol className="seo-faq-list">
          {faq.map((item, index) => (
            <li key={index} className="seo-faq-row" data-testid="category-seo-faq-row">
              <label className="field">
                <span>
                  Soru {index + 1} <Counter value={item.question.length} max={FAQ_QUESTION_MAX} />
                </span>
                <input
                  value={item.question}
                  maxLength={FAQ_QUESTION_MAX}
                  onChange={(event) => setFaqItem(index, { question: event.target.value.replace(/\r?\n/g, ' ') })}
                  aria-invalid={halfRows.includes(index + 1) ? true : undefined}
                  data-testid="category-seo-faq-question"
                />
              </label>
              <label className="field">
                <span>
                  Cevap <Counter value={item.answer.length} max={FAQ_ANSWER_MAX} />
                </span>
                <textarea
                  rows={3}
                  value={item.answer}
                  maxLength={FAQ_ANSWER_MAX}
                  onChange={(event) => setFaqItem(index, { answer: event.target.value })}
                  aria-invalid={halfRows.includes(index + 1) ? true : undefined}
                  data-testid="category-seo-faq-answer"
                />
              </label>
              <button
                type="button"
                className="btn btn-link btn-sm"
                onClick={() => setFaq((rows) => rows.filter((_, at) => at !== index))}
                aria-label={`Soru ${index + 1}'i kaldır`}
                data-testid="category-seo-faq-remove"
              >
                Kaldır
              </button>
            </li>
          ))}
        </ol>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={faq.length >= FAQ_MAX_ITEMS}
          onClick={() => setFaq((rows) => [...rows, { question: '', answer: '' }])}
          data-testid="category-seo-faq-add"
        >
          Soru ekle
        </button>
        {faq.length >= FAQ_MAX_ITEMS ? (
          <p className="help-text">En fazla {FAQ_MAX_ITEMS} soru eklenebilir.</p>
        ) : null}
        {halfRows.length > 0 ? (
          <p className="help-text is-error" role="alert" data-testid="category-seo-faq-half">
            {halfRows.join(', ')}. sorunun soru ve cevabı birlikte yazılmalı (ya da satır kaldırılmalı).
          </p>
        ) : null}
      </fieldset>

      {error ? (
        <div className="notice notice-error" role="alert" data-testid="category-seo-error">
          {error.message}
        </div>
      ) : null}
      {state.kind === 'saved' ? (
        <div className="notice notice-success" role="status" data-testid="category-seo-saved">
          Arama motoru içeriği kaydedildi.
        </div>
      ) : null}

      <div className="detail-form-footer">
        <p className="detail-form-footer-note">
          Kaydedilen metin kategori sayfasında düz metin olarak görünür. Aramaya açılma kuralı yalnız harf ve rakamları sayar.
        </p>
        <div className="detail-form-footer-actions">
          <SaveButton disabled={tooLong || halfRows.length > 0} />
        </div>
      </div>
    </form>
  );
}

function Counter({ value, max, min = null, testId }: { value: number; max: number; min?: number | null; testId?: string }) {
  const over = value > max;
  return (
    <span className={over ? 'seo-counter is-over' : 'seo-counter'} data-testid={testId}>
      {value} / {max}
      {min ? <span className="cell-muted"> · aramaya açılmak için en az {min} harf/rakam</span> : null}
    </span>
  );
}

function SaveButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className="btn btn-primary" type="submit" disabled={disabled || pending} data-testid="category-seo-save">
      {pending ? 'Kaydediliyor…' : 'Arama motoru içeriğini kaydet'}
    </button>
  );
}
