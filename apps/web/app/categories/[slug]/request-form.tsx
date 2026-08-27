'use client';

import { useMemo, useRef, useState, type RefObject } from 'react';
import type { ContactDisclosureConfig, Question } from '../../../lib/api';
import type { ProvinceWithDistricts } from '../../../lib/locations';
import { LocationFields } from './location-fields';
import { IconArrowLeft, IconArrowRight, IconCheck } from '../../landing-icons';

type RequestFormProps = {
  categorySlug: string;
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
      <input type="hidden" name="categorySlug" value={categorySlug} />
      <input
        type="hidden"
        name="questionMeta"
        value={JSON.stringify(questions.map((question) => ({ key: question.key, type: question.type })))}
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
            {questions.length > 0 ? (
              <section className="form-section">
                <h2>Talep detayları</h2>
                <p className="form-section-subtitle">
                  Hizmet verenlerin doğru teklif verebilmesi için kategoriye özel soruları
                  yanıtlayın.
                </p>
                {questions.map((question) => (
                  <RequestField key={question.id} question={question} />
                ))}
              </section>
            ) : null}

            <section className="form-section">
              <h2>İş açıklaması</h2>
              <label className="form-row">
                <span>Açıklama</span>
                <textarea
                  name="description"
                  placeholder="Yapılacak işi kısaca anlatın: ne, nerede, hangi durumda."
                />
                <span className="help-text">
                  Detay yazdıkça talebin kalite skoru yükselir ve daha isabetli teklif alırsınız.
                </span>
              </label>
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
              <LocationFields provinces={provinces} onChange={refreshSignals} />
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
                  <span>Tercih edilen tarih</span>
                  <input name="preferredDate" type="date" />
                </label>
                <label className="form-row">
                  <span>Minimum bütçe</span>
                  <input
                    name="budgetMin"
                    type="number"
                    step="0.01"
                    min="1"
                    inputMode="decimal"
                    placeholder="Örn. 1500.00"
                  />
                  <span className="help-text">İsteğe bağlı. Ondalıklı tutar girebilirsiniz.</span>
                </label>
                <label className="form-row">
                  <span>Maksimum bütçe</span>
                  <input
                    name="budgetMax"
                    type="number"
                    step="0.01"
                    min="1"
                    inputMode="decimal"
                    placeholder="Örn. 3000.00"
                  />
                  <span className="help-text">İsteğe bağlı. Boş bırakabilirsiniz.</span>
                </label>
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
