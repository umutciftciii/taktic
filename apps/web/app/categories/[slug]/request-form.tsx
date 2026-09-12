'use client';

import { useMemo, useRef, useState, type RefObject } from 'react';
import type { ContactDisclosureConfig, Question, RouterSelection } from '../../../lib/api';
import type { ProvinceWithDistricts } from '../../../lib/locations';
import { boundQuestion, encodeRouterSelections, visibleQuestions } from '../../../lib/request-flow';
import {
  ContactSection,
  EMPTY_ALTERNATE_CONTACT,
  accountContactIsComplete,
  type AccountContact,
} from '../../request-fields/contact-section';
import { DescriptionField } from '../../request-fields/description-field';
import { ContactDisclosureField } from '../../request-fields/disclosure-field';
import { LocationFields } from '../../request-fields/location-fields';
import { RequestField, encodeQuestionMeta, readAnswers } from '../../request-fields/question-field';
import { UrgencySelect } from '../../request-fields/timing-fields';
import { BudgetFields } from './budget-fields';
import { ShowcaseMatches } from './showcase-matches';
import { IconArrowLeft, IconArrowRight, IconCheck } from '../../landing-icons';

export type { AccountContact };

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
  /**
   * The leaf category's own id.
   *
   * Only the vitrin block reads it, and only to ask "which cards are published
   * for this service in this district". The request itself is still posted
   * under the *entry* slug — see the hidden field below — so this cannot become
   * a second, competing way of naming the category.
   */
  categoryId: string;
  questions: Question[];
  disclosure: ContactDisclosureConfig;
  showDisclosure: boolean;
  /** Turkey's provinces with their districts, loaded by the page from the API. */
  provinces: ProvinceWithDistricts[];
  /**
   * The signed-in customer's account contact, or null for a visitor with no
   * customer session. Null is what makes this the guest form: the three contact
   * fields are asked for, exactly as they always were.
   */
  accountContact?: AccountContact | null;
  /** The existing server action; this component only decides what is on screen. */
  action: (formData: FormData) => void | Promise<void>;
};

const STEPS = [
  { key: 'detail', label: 'İş detayı' },
  { key: 'place', label: 'Konum & zaman' },
  { key: 'contact', label: 'İletişim' },
] as const;

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
  categoryId,
  routerSelections = [],
  questions,
  disclosure,
  showDisclosure,
  provinces,
  accountContact = null,
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
   * Where the work is, mirrored into state.
   *
   * The three selects remain the payload's source of truth — the server action
   * reads the posted fields, exactly as before. This copy exists for the vitrin
   * block, which has to ask the API a question keyed on the place and cannot
   * read it out of the DOM during a change event without seeing a dependent
   * select React has not cleared yet.
   */
  const [place, setPlace] = useState({ city: '', district: '', neighborhood: '' });

  /*
   * Whether the customer asked to name somebody else, and what they typed.
   * Controlled state, owned here and rendered by the shared ContactSection —
   * see its notes on why the values are erased rather than hidden.
   */
  const [useAlternateContact, setUseAlternateContact] = useState(false);
  const [alternateContact, setAlternateContact] = useState(EMPTY_ALTERNATE_CONTACT);

  const accountContactComplete = accountContactIsComplete(accountContact);
  /**
   * A signed-in customer whose account is missing one of the three. The default
   * path cannot work for them — the API refuses it — so the form says so and
   * withholds submit until they name a contact person instead.
   */
  const accountContactIncomplete = Boolean(accountContact) && !accountContactComplete;
  const submitBlocked = accountContactIncomplete && !useAlternateContact;

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

  /*
   * The contact signal, which now has two sources.
   *
   * A guest fills the three fields in and `refreshSignals` reads them from the
   * DOM, exactly as before. A signed-in customer on the default path has no
   * fields to read — the details come from their account — so the signal is
   * derived from state instead, and the estimate keeps counting contact as
   * done rather than punishing them for a step the product filled in for them.
   */
  const contactSignal = accountContact
    ? useAlternateContact
      ? Boolean(
          alternateContact.name.trim() &&
            alternateContact.phone.trim() &&
            alternateContact.email.trim(),
        )
      : accountContactComplete
    : signals.contact;

  const checklist = useMemo(
    () => [
      { label: 'İş detayı yazıldı', done: signals.detail },
      { label: 'Konum girildi', done: signals.place },
      { label: 'Zaman veya bütçe belirtildi', done: signals.time },
      { label: 'İletişim bilgisi verildi', done: contactSignal },
    ],
    [signals, contactSignal],
  );

  const estimate = checklist.filter((item) => item.done).length * 25;

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

    setAnswers(readAnswers(form, questions));

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
      <input type="hidden" name="questionMeta" value={encodeQuestionMeta(answerableQuestions)} />

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
              <DescriptionField question={descriptionQuestion} />
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
                onChange={(value) => {
                  setPlace(value);
                  refreshSignals();
                }}
                neighborhoodRequired={addressQuestion?.isRequired ?? false}
                neighborhoodHelpText={addressQuestion?.helpText}
              />
              <label className="form-row">
                <span>Adres notu</span>
                <textarea name="addressNote" placeholder="Ek bilgi / yol tarifi" />
              </label>
            </section>

            {/*
              The vitrin cards published for this service in this district.

              Directly after the location and before time and budget, because it
              is the first moment the question can be asked at all — and because
              a customer who would rather go straight to one business should
              find that out before writing the rest of the form, not after.

              It changes nothing about the request beside it. Picking a card
              leaves this page; picking nothing submits the ordinary
              marketplace request exactly as it always was.
            */}
            <ShowcaseMatches
              categoryId={categoryId}
              city={place.city}
              district={place.district}
              neighborhood={place.neighborhood}
            />

            <section className="form-section">
              <h2>Zaman ve bütçe</h2>
              <div className="form-grid">
                <UrgencySelect />
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

              <ContactSection
                accountContact={accountContact}
                useAlternateContact={useAlternateContact}
                onUseAlternateContactChange={setUseAlternateContact}
                alternateContact={alternateContact}
                onAlternateContactChange={setAlternateContact}
              />

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
                <ContactDisclosureField disclosure={disclosure} />
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

            {/*
              The two keys are load-bearing, not decoration.

              Without them React sees one <button className="btn btn-primary">
              in this slot and reuses the same DOM node when the last step is
              reached — rewriting its `type` from "button" to "submit" during
              the very click that got there, before the browser runs that
              click's activation behaviour. The browser then activates a submit
              button, and "Devam et" posts the form. Distinct keys make the
              clicked node unmount instead: a detached button has no form to
              submit.

              The bug was invisible while the contact step always held empty
              required fields — native validation refused the accidental submit
              and the customer saw nothing. A signed-in customer's step has no
              empty field left to refuse it.
            */}
            {isLast ? (
              /*
                Withheld only for the one case the API will refuse anyway: a
                signed-in customer whose account has no complete contact and who
                has not named anybody else. `title` and the notice above both
                say why, so the disabled control is never a dead end without an
                explanation.
              */
              <button
                key="submit"
                className="btn btn-primary"
                type="submit"
                disabled={submitBlocked}
                title={
                  submitBlocked
                    ? 'Hesabınızdaki iletişim bilgileri eksik. Farklı bir iletişim kişisi tanımlayın.'
                    : undefined
                }
              >
                Talebi Gönder
                <IconArrowRight />
              </button>
            ) : (
              <button
                key="next"
                type="button"
                className="btn btn-primary"
                onClick={() => goTo(step + 1)}
              >
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
