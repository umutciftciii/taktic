'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH } from '@taktic/shared';
import type { ContactDisclosureConfig, Question, RouterSelection } from '../../../lib/api';
import type { ProvinceWithDistricts } from '../../../lib/locations';
import { boundQuestion, encodeRouterSelections, visibleQuestions } from '../../../lib/request-flow';
import { BudgetFields } from './budget-fields';
import { LocationFields } from './location-fields';
import { IconArrowLeft, IconArrowRight, IconCheck } from '../../landing-icons';

type RequestFormProps = {
  /**
   * The leaf this form belongs to. When the customer arrived through a router
   * it is *not* what the request is posted under — see `entryCategorySlug`.
   */
  categorySlug: string;
  /**
   * The category the customer started from, when routing brought them here.
   * The API re-walks the selections from this slug and derives the leaf itself;
   * the form never posts a destination.
   */
  entryCategorySlug?: string;
  /** The routing steps taken to reach this form, in order. */
  routerSelections?: RouterSelection[];
  questions: Question[];
  disclosure: ContactDisclosureConfig;
  showDisclosure: boolean;
  /** Turkey's provinces with their districts, loaded by the page from the API. */
  provinces: ProvinceWithDistricts[];
  /** The existing server action; this component only decides what is on screen. */
  action: (formData: FormData) => void | Promise<void>;
};

const STEPS = [
  { key: 'detail', label: 'İş detayı' },
  { key: 'place', label: 'Konum & zaman' },
  { key: 'contact', label: 'İletişim' },
] as const;

/**
 * Where the description counter starts warning, in characters.
 *
 * Purely presentational — the rule itself is
 * SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH, which the API enforces. This only
 * decides when the customer is told they are running out of room, early enough
 * to be useful while there is still a paragraph left to write.
 */
const DESCRIPTION_NEAR_LIMIT_AT = 4500;

/**
 * The public request form, in the three steps the design defines.
 *
 * Every field stays mounted for the whole flow — only the active step is shown —
 * so the single POST the server action already expects is unchanged: one form,
 * the same field names, the same payload.
 *
 * Moving forward runs the browser's own validation over the fields of the step
 * being left, which is also why a later step can never be reached with a
 * required field still empty: submit would otherwise fail on a control the
 * customer cannot see.
 */
export function RequestForm({
  categorySlug,
  entryCategorySlug,
  routerSelections = [],
  questions,
  disclosure,
  showDisclosure,
  provinces,
  action,
}: RequestFormProps) {
  const [step, setStep] = useState(0);
  const detailRef = useRef<HTMLDivElement>(null);
  const placeRef = useRef<HTMLDivElement>(null);
  const contactRef = useRef<HTMLDivElement>(null);
  const stepRefs: ReadonlyArray<RefObject<HTMLDivElement | null>> = [
    detailRef,
    placeRef,
    contactRef,
  ];

  /*
   * A client-side estimate, never the score itself. The API computes the real
   * quality score when the request is created; this only reflects which
   * signals the customer has filled in so far, and says so on screen.
   */
  const [signals, setSignals] = useState({
    detail: false,
    place: false,
    time: false,
    contact: false,
  });

  /*
   * What has been answered so far, keyed by question key.
   *
   * Only conditional visibility reads it — the values themselves are still
   * posted by the controls, exactly as before. Keeping it in state rather than
   * re-reading the DOM on render is what makes a dependent question appear the
   * moment its trigger is chosen.
   */
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});

  /*
   * The description's length, mirrored into state purely so the counter can
   * render it. The textarea itself stays uncontrolled — the server action reads
   * the posted field, exactly as before — so this never becomes the value's
   * source of truth. React's onChange is the `input` event, which is what makes
   * typing, deleting and pasting all land here.
   */
  const [descriptionLength, setDescriptionLength] = useState(0);

  /*
   * Browsers restore a textarea's text when the customer comes back to this
   * page — with the Back button, or from bfcache — but they do not re-run the
   * change handler that fed the count. Reading the field once on mount is what
   * stops the counter from claiming 0 under a description that is plainly
   * there. It only ever reads; the field stays uncontrolled.
   */
  useEffect(() => {
    const field = detailRef.current
      ?.closest('form')
      ?.elements.namedItem('description');
    if (field instanceof HTMLTextAreaElement) {
      setDescriptionLength(field.value.length);
    }
  }, []);

  const shown = useMemo(() => visibleQuestions(questions, answers), [questions, answers]);

  /*
   * A bound question is not an input of its own: it renames the built-in field
   * it names and can make it mandatory for this category. The value goes on
   * living in the request column the rest of the product already reads, which
   * is why nothing below ever posts an answer for one.
   */
  const descriptionQuestion = boundQuestion(shown, 'DESCRIPTION');
  const budgetQuestion = boundQuestion(shown, 'BUDGET');
  const preferredDateQuestion = boundQuestion(shown, 'PREFERRED_DATE');
  const addressQuestion = boundQuestion(shown, 'ADDRESS');

  /** The questions that are actually rendered as inputs. */
  const answerableQuestions = shown.filter((question) => !question.systemField);

  const checklist = useMemo(
    () => [
      { label: 'İş detayı yazıldı', done: signals.detail },
      { label: 'Konum girildi', done: signals.place },
      { label: 'Zaman veya bütçe belirtildi', done: signals.time },
      { label: 'İletişim bilgisi verildi', done: signals.contact },
    ],
    [signals],
  );

  const estimate = checklist.filter((item) => item.done).length * 25;

  /*
   * What the counter says beyond the bare numbers. Both states are spelled out
   * in words rather than signalled by colour alone, so the warning survives
   * greyscale, low vision and a screen reader.
   */
  const descriptionAtLimit = descriptionLength >= SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH;
  const descriptionNearLimit = !descriptionAtLimit && descriptionLength > DESCRIPTION_NEAR_LIMIT_AT;
  const descriptionStatus = descriptionAtLimit
    ? 'Karakter sınırına ulaştınız'
    : descriptionNearLimit
      ? 'Sınıra yaklaşıyorsunuz'
      : null;

  function refreshSignals() {
    const form = detailRef.current?.closest('form');
    if (!form) return;

    const value = (name: string) => {
      const el = form.elements.namedItem(name);
      if (!el) return '';
      if (el instanceof RadioNodeList) return el.value.trim();
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        return el.value.trim();
      }
      return '';
    };

    const nextAnswers: Record<string, string | string[]> = {};
    for (const question of questions) {
      if (question.systemField) {
        continue;
      }

      const element = form.elements.namedItem(`answer_${question.key}`);

      if (element instanceof HTMLSelectElement && element.multiple) {
        nextAnswers[question.key] = Array.from(element.selectedOptions).map(
          (option) => option.value,
        );
      } else if (element instanceof HTMLInputElement && element.type === 'checkbox') {
        nextAnswers[question.key] = element.checked ? 'true' : 'false';
      } else if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      ) {
        nextAnswers[question.key] = element.value;
      }
    }
    setAnswers(nextAnswers);

    setSignals({
      detail: value('description').length >= 40,
      place: Boolean(value('city') && value('district')),
      time: Boolean(value('preferredDate') || value('urgency') || value('budgetMin') || value('budgetMax')),
      contact: Boolean(value('customerName') && value('customerPhone') && value('customerEmail')),
    });
  }

  /** True when every control inside the given step passes native validation. */
  function stepIsValid(index: number): boolean {
    const container = stepRefs[index]?.current;
    if (!container) return true;

    const controls = Array.from(
      container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        'input, textarea, select',
      ),
    );

    for (const control of controls) {
      if (!control.checkValidity()) {
        control.reportValidity();
        return false;
      }
    }

    return true;
  }

  function goTo(index: number) {
    if (index === step) return;

    // Backwards is always allowed; forwards has to pass the steps in between.
    if (index > step) {
      for (let cursor = step; cursor < index; cursor += 1) {
        if (!stepIsValid(cursor)) {
          setStep(cursor);
          return;
        }
      }
    }

    refreshSignals();
    setStep(index);
  }

  const isLast = step === STEPS.length - 1;

  return (
    <form action={action} className="form-card" onChange={refreshSignals}>
      {/*
        The category the request is posted under is the *entry* one. For an
        ordinary service that is this leaf and nothing changed; for a routed
        flow it is where the customer started, and the API derives the leaf
        again from the selections below. The form never names a destination.
      */}
      <input type="hidden" name="categorySlug" value={entryCategorySlug ?? categorySlug} />
      <input
        type="hidden"
        name="routerSelections"
        value={encodeRouterSelections(routerSelections)}
      />
      {/*
        Only the questions that are on screen. A hidden one carries no answer,
        and the API refuses one that arrives anyway.
      */}
      <input
        type="hidden"
        name="questionMeta"
        value={JSON.stringify(
          answerableQuestions.map((question) => ({ key: question.key, type: question.type })),
        )}
      />

      <div className="req-body">
        <div className="req-main">
          <div className="stepper" role="tablist" aria-label="Talep formu adımları">
            {STEPS.map((entry, index) => (
              <button
                key={entry.key}
                type="button"
                role="tab"
                aria-selected={index === step}
                aria-controls={`request-step-${entry.key}`}
                className={`step-tab${index === step ? ' is-active' : ''}`}
                onClick={() => goTo(index)}
              >
                <span className="step-tab-index">Adım 0{index + 1}</span>
                <span className="step-tab-label">{entry.label}</span>
              </button>
            ))}
          </div>

          <div
            id="request-step-detail"
            ref={detailRef}
            className="step-panel"
            hidden={step !== 0}
          >
            {answerableQuestions.length > 0 ? (
              <section className="form-section">
                <h2>Talep detayları</h2>
                <p className="form-section-subtitle">
                  Hizmet verenlerin doğru teklif verebilmesi için kategoriye özel soruları
                  yanıtlayın.
                </p>
                {answerableQuestions.map((question) => (
                  <RequestField key={question.id} question={question} />
                ))}
              </section>
            ) : null}

            <section className="form-section">
              <h2>İş açıklaması</h2>
              <label className="form-row">
                <span>
                  {descriptionQuestion?.label ?? 'Açıklama'}
                  {descriptionQuestion?.isRequired ? ' *' : ''}
                </span>
                <textarea
                  name="description"
                  required={descriptionQuestion?.isRequired ?? false}
                  data-testid="request-description"
                  maxLength={SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH}
                  aria-describedby="request-description-help request-description-counter"
                  onChange={(event) => setDescriptionLength(event.target.value.length)}
                  placeholder="Yapılacak işi kısaca anlatın: ne, nerede, hangi durumda."
                />
              </label>
              {/*
                * The help text and the counter share one row — guidance on the
                * left, the count on the right — because they answer the same
                * question about the field and reading them as two stacked lines
                * made the count look like a stray label.
                *
                * Both sit outside the label on purpose. A count that changes on
                * every keystroke inside it would keep rewriting the field's
                * accessible name; as descriptions they are announced when the
                * field is reached, and the status line — which only changes at
                * the two thresholds, so it is not chatty — announces itself.
                */}
              <div className="description-meta">
                <span className="help-text" id="request-description-help">
                  {descriptionQuestion?.helpText ??
                    'Detay yazdıkça talebin kalite skoru yükselir ve daha isabetli teklif alırsınız.'}
                </span>
                <p
                  className="description-counter"
                  id="request-description-counter"
                  data-testid="request-description-counter"
                  data-state={descriptionAtLimit ? 'limit' : descriptionNearLimit ? 'near' : 'ok'}
                >
                  <span className="description-counter-count">
                    {descriptionLength} / {SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH}
                    <span className="visually-hidden"> karakter kullanıldı</span>
                  </span>
                  <span className="description-counter-status" role="status">
                    {descriptionStatus}
                  </span>
                </p>
              </div>
            </section>
          </div>

          <div
            id="request-step-place"
            ref={placeRef}
            className="step-panel"
            hidden={step !== 1}
          >
            <section className="form-section">
              <h2>Konum</h2>
              <LocationFields
                provinces={provinces}
                onChange={refreshSignals}
                neighborhoodRequired={addressQuestion?.isRequired ?? false}
                neighborhoodHelpText={addressQuestion?.helpText}
              />
              <label className="form-row">
                <span>Adres notu</span>
                <textarea name="addressNote" placeholder="Ek bilgi / yol tarifi" />
              </label>
            </section>

            <section className="form-section">
              <h2>Zaman ve bütçe</h2>
              <div className="form-grid">
                <label className="form-row">
                  <span>Aciliyet</span>
                  <select name="urgency" defaultValue="">
                    <option value="">Seçiniz</option>
                    <option value="TODAY">Bugün</option>
                    <option value="THIS_WEEK">Bu hafta</option>
                    <option value="FLEXIBLE">Esnek</option>
                  </select>
                </label>
                <label className="form-row">
                  <span>
                    {preferredDateQuestion?.label ?? 'Tercih edilen tarih'}
                    {preferredDateQuestion?.isRequired ? ' *' : ''}
                  </span>
                  <input
                    name="preferredDate"
                    type="date"
                    required={preferredDateQuestion?.isRequired ?? false}
                    data-testid="request-preferred-date"
                  />
                  {preferredDateQuestion?.helpText ? (
                    <span className="help-text">{preferredDateQuestion.helpText}</span>
                  ) : null}
                </label>
                <BudgetFields
                  minLabel={budgetQuestion?.label ?? 'Minimum bütçe'}
                  required={budgetQuestion?.isRequired ?? false}
                  minHelpText={budgetQuestion?.helpText}
                  onChange={refreshSignals}
                />
              </div>
            </section>
          </div>

          <div
            id="request-step-contact"
            ref={contactRef}
            className="step-panel"
            hidden={step !== 2}
          >
            <section className="form-section">
              <h2>İletişim</h2>
              <div className="form-grid">
                <label className="form-row">
                  <span>Ad soyad *</span>
                  <input name="customerName" required />
                </label>
                <label className="form-row">
                  <span>Telefon *</span>
                  <input name="customerPhone" required placeholder="05XX XXX XX XX" />
                </label>
              </div>
              <label className="form-row">
                <span>E-posta *</span>
                <input
                  name="customerEmail"
                  type="email"
                  required
                  placeholder="ornek@eposta.com"
                />
                <span className="help-text">
                  Tekliflerinizi takip edebilmeniz için e-posta adresiniz gereklidir.
                </span>
              </label>

              {/*
                Telefon doğrulaması talep oluşturulduktan sonra, talebin kendi
                ekranında yapılır: kod bir talep kaydına gönderilir. Burada
                yalnızca ne olacağı anlatılır — çalışmayan bir kutu konmaz.
              */}
              <div className="verify-well">
                <span className="cdash-summary-label">Telefon doğrulama</span>
                <p style={{ margin: 0, fontSize: 13 }}>
                  Talebinizi gönderdikten sonra talep ekranınızdan telefonunuza doğrulama kodu
                  isteyebilirsiniz. Doğrulama, talebinizin doğru kişiye ulaştığını teyit eder.
                </p>
              </div>
            </section>

            {showDisclosure ? (
              <section className="form-section">
                <h2>Bilgilendirme</h2>
                {/*
                  The checkbox states one thing only: that the linked text was read.
                  It does not paraphrase, summarise or stand in for that text — the
                  disclosure itself lives at CONTACT_DISCLOSURE_URL, and the feature
                  cannot be switched on until it does.
                */}
                <input
                  type="hidden"
                  name="contactDisclosureVersion"
                  value={disclosure.disclosureVersion ?? ''}
                />
                <label className="checkbox-row" htmlFor="contact-disclosure">
                  <input
                    id="contact-disclosure"
                    name="contactDisclosureAccepted"
                    type="checkbox"
                    value="true"
                    required
                    data-testid="contact-disclosure-accept"
                  />
                  <span>
                    <a
                      href={disclosure.disclosureUrl ?? '#'}
                      target="_blank"
                      rel="noreferrer"
                      data-testid="contact-disclosure-link"
                    >
                      İletişim bilgilerinin paylaşılmasına ilişkin bilgilendirme metnini
                    </a>{' '}
                    okudum.
                  </span>
                </label>
              </section>
            ) : null}
          </div>

          <div className="step-foot">
            <div className="inline-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => goTo(step - 1)}
                disabled={step === 0}
              >
                <IconArrowLeft size={14} />
                Geri
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                * zorunlu alanlar
              </span>
            </div>

            {isLast ? (
              <button className="btn btn-primary" type="submit">
                Talebi Gönder
                <IconArrowRight />
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={() => goTo(step + 1)}>
                Devam et
                <IconArrowRight />
              </button>
            )}
          </div>
        </div>

        <aside className="req-rail" aria-label="Talep kalite tahmini">
          <div className="quality-card">
            <div>
              <span className="cdash-summary-label">Talep kalite skoru</span>
              <div className="quality-head">
                <span className="quality-score">
                  {estimate}
                  <sup>/100</sup>
                </span>
                <span className="tag tag-neutral">Tahmin</span>
              </div>
              <div className="databar" style={{ marginTop: 12 }}>
                <div className="databar-fill" style={{ width: `${estimate}%` }} />
              </div>
            </div>

            <ul className="quality-list">
              {checklist.map((item) => (
                <li className="quality-item" key={item.label}>
                  <span className={`check-square${item.done ? '' : ' check-square-idle'}`}>
                    {item.done ? <IconCheck size={10} /> : null}
                  </span>
                  <span>{item.label}</span>
                </li>
              ))}
            </ul>

            <p className="quality-note">
              Buradaki değer yalnızca doldurduğunuz alanlara bakan bir tahmindir. Kesin kalite
              skoru talebiniz oluşturulduğunda sunucu tarafında hesaplanır ve talep ekranınızda
              görünür.
            </p>
          </div>

          <div className="rail-note" style={{ marginTop: 24 }}>
            <strong>Sırada ne var?</strong> Talebiniz ön incelemeden geçtikten sonra bölgenizdeki
            onaylı hizmet verenlere iletilir ve 14 gün boyunca teklif alır.
          </div>
        </aside>
      </div>
    </form>
  );
}

function RequestField({ question }: { question: Question }) {
  return (
    <label className="form-row">
      <span>
        {question.label}
        {question.isRequired ? ' *' : ''}
      </span>
      {renderInput(question)}
      {question.helpText ? <span className="help-text">{question.helpText}</span> : null}
    </label>
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
        <select name={name} required={question.isRequired} defaultValue="">
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
      return (
        <span className="checkbox-row">
          <input name={name} type="checkbox" value="true" />
          <span>Evet</span>
        </span>
      );
    case 'DATE':
      return <input name={name} type="date" required={question.isRequired} />;
    case 'IMAGE':
      return <input name={name} placeholder="Dosya yükleme sonraki fazda" required={question.isRequired} />;
  }
}
