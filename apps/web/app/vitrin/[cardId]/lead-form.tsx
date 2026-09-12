'use client';

import Link from 'next/link';
import { useMemo, useRef, useState, useTransition, type FormEvent } from 'react';
import type { ContactDisclosureConfig, Question, ShowcaseFeedCard } from '../../../lib/api';
import type { ProvinceWithDistricts } from '../../../lib/locations';
import { boundQuestion, visibleQuestions } from '../../../lib/request-flow';
import { showcaseLeadRefusalText } from '../../../lib/showcase-lead-errors';
import {
  ContactSection,
  EMPTY_ALTERNATE_CONTACT,
  accountContactIsComplete,
  type AccountContact,
  type AlternateContact,
} from '../../request-fields/contact-section';
import { DescriptionField } from '../../request-fields/description-field';
import { ContactDisclosureField } from '../../request-fields/disclosure-field';
import { LocationFields } from '../../request-fields/location-fields';
import { RequestField, encodeQuestionMeta, readAnswers } from '../../request-fields/question-field';
import { UrgencySelect } from '../../request-fields/timing-fields';
import {
  confirmShowcaseLeadVerificationAction,
  createShowcaseLeadAction,
  startShowcaseLeadVerificationAction,
  type LeadActionResult,
} from './actions';

/**
 * The refusal this form exists to handle well.
 *
 * The customer read a card, chose it, and then named an address the business
 * does not serve. Nothing they did was wrong — the home page shows every live
 * card now, precisely so a visitor does not have to declare a location before
 * seeing anything — so the answer has to be a route onward rather than a red
 * box. The ordinary marketplace request reaches every matching business in
 * their district, which is what they actually wanted.
 */
const AREA_NOT_SERVED = 'SHOWCASE_LEAD_AREA_NOT_SERVED';
const PHONE_PROOF_REQUIRED = 'SHOWCASE_LEAD_PHONE_VERIFICATION_REQUIRED';

/** The sentence for a refusal — see showcaseLeadRefusalText for the precedence. */
function refusalText(failure: Extract<LeadActionResult, { ok: false }>): string {
  return showcaseLeadRefusalText(failure);
}

type Verification =
  | { status: 'idle' }
  | { status: 'sending'; phone: string }
  | { status: 'code'; phone: string; error: string | null; verifying: boolean }
  | { status: 'verified'; phone: string };

type LeadFormProps = {
  card: ShowcaseFeedCard;
  cardId: string;
  /** The card's service area, worded by the page ("Kadıköy, İstanbul"). */
  coverage: string;
  provinces: ProvinceWithDistricts[];
  /** The card's category's questions — a lead answers what the category asks. */
  questions: Question[];
  disclosure: ContactDisclosureConfig;
  showDisclosure: boolean;
  accountContact: AccountContact | null;
  /**
   * A location the customer already chose somewhere else — on the marketplace
   * request form, where the vitrin cards for their own category and district
   * are offered — and a number they typed before a reload. Prefill only: the
   * server re-resolves and re-checks all of it.
   */
  prefill: { city: string; district: string; neighborhood: string; phone: string };
};

/**
 * The form that writes to the business behind a vitrin card.
 *
 * ## One screen, the marketplace form's own parts
 *
 * Everything the marketplace request form asks is asked here with the same
 * components — the dependent province/district/neighbourhood selects, the
 * category's questions, the description with its counter, the timing select,
 * the contact section and the disclosure — so a lead is an ordinary request
 * body and cannot post a value the API's DTO would refuse. The old flow's
 * free-text district was exactly that: a spelling the canonical list did not
 * know, refused by the DTO, reported as a generic failure.
 *
 * ## Two timing questions, on purpose
 *
 * "When do you want the work done" is the request's own `urgency`, chosen
 * from the same three options as any marketplace request. "How soon should
 * the business reply" is `urgencyBucket`, the card's promise: rendered from
 * **this card's own** approved hours, chosen explicitly, and posted as its own
 * field. Neither is derived from the other, here or on the server — a
 * same-day job is very often one somebody is happy to be called about
 * tomorrow.
 *
 * ## The number is proved inside the form
 *
 * The lead reaches one business the moment it is written, so the proof comes
 * before the request exists (see actions.ts). It happens here, next to the
 * telephone field, without leaving the page: the customer keeps everything
 * they typed, and the proof binds to the exact number in the field, which is
 * locked once a code has been sent for it.
 */
export function ShowcaseLeadForm({
  card,
  cardId,
  coverage,
  provinces,
  questions,
  disclosure,
  showDisclosure,
  accountContact,
  prefill,
}: LeadFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();

  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [guestContact, setGuestContact] = useState<AlternateContact>({
    ...EMPTY_ALTERNATE_CONTACT,
    phone: prefill.phone,
  });
  const [useAlternateContact, setUseAlternateContact] = useState(false);
  const [alternateContact, setAlternateContact] = useState(EMPTY_ALTERNATE_CONTACT);
  const [verification, setVerification] = useState<Verification>({ status: 'idle' });
  const [failure, setFailure] = useState<Extract<LeadActionResult, { ok: false }> | null>(null);

  const shown = useMemo(() => visibleQuestions(questions, answers), [questions, answers]);
  const descriptionQuestion = boundQuestion(shown, 'DESCRIPTION');
  const addressQuestion = boundQuestion(shown, 'ADDRESS');
  const answerableQuestions = shown.filter((question) => !question.systemField);

  /*
   * The number the proof is for: the account's on the default path of a
   * signed-in customer, otherwise whatever is in the telephone field. The API
   * resolves the request's contact the same way, so the number it binds the
   * proof to is the number the request is stored with.
   */
  const accountPath = accountContact !== null && !useAlternateContact;
  const phone = accountPath
    ? (accountContact?.phone ?? '')
    : useAlternateContact
      ? alternateContact.phone
      : guestContact.phone;

  const accountContactIncomplete = accountContact !== null && !accountContactIsComplete(accountContact);
  const submitBlocked = accountContactIncomplete && !useAlternateContact;
  const verified = verification.status === 'verified';
  const phoneLocked = verification.status !== 'idle';

  function resetVerification() {
    setVerification({ status: 'idle' });
  }

  function sendCode() {
    const target = phone.trim();
    if (!target) {
      setVerification({ status: 'code', phone: '', error: 'Önce telefon numaranızı yazın.', verifying: false });
      return;
    }

    setFailure(null);
    setVerification({ status: 'sending', phone: target });
    startTransition(async () => {
      const result = await startShowcaseLeadVerificationAction(target);
      setVerification(
        result.ok
          ? { status: 'code', phone: target, error: null, verifying: false }
          : { status: 'code', phone: target, error: refusalText(result), verifying: false },
      );
    });
  }

  function confirmCode(code: string) {
    if (verification.status !== 'code') return;
    const { phone: target } = verification;

    if (!/^\d{6}$/.test(code.trim())) {
      setVerification({ status: 'code', phone: target, error: '6 haneli kodu girin.', verifying: false });
      return;
    }

    setVerification({ status: 'code', phone: target, error: null, verifying: true });
    startTransition(async () => {
      const result = await confirmShowcaseLeadVerificationAction(target, code.trim());
      setVerification(
        result.ok
          ? { status: 'verified', phone: target }
          : { status: 'code', phone: target, error: refusalText(result), verifying: false },
      );
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    // Submitted by hand rather than through the form's `action`, so React
    // does not reset the uncontrolled fields when the action answers with a
    // refusal — the description and the answers stay exactly as typed.
    event.preventDefault();
    if (!verified || submitBlocked) return;

    const data = new FormData(event.currentTarget);
    setFailure(null);
    startTransition(async () => {
      const result = await createShowcaseLeadAction(data);
      if (!result.ok) {
        setFailure(result);
        // A proof that lapsed while the form was being filled in has to be
        // made again; leaving "verified" on screen would invite a second
        // refusal for the same reason.
        if (result.code === PHONE_PROOF_REQUIRED) {
          resetVerification();
        }
      }
    });
  }

  const areaNotServed = failure?.code === AREA_NOT_SERVED;

  return (
    <form
      ref={formRef}
      className="pdash-form showcase-lead"
      data-testid="showcase-lead-form"
      onSubmit={handleSubmit}
      onChange={() => {
        const form = formRef.current;
        if (form) setAnswers(readAnswers(form, questions));
      }}
    >
      <input type="hidden" name="cardId" value={cardId} />
      <input type="hidden" name="categorySlug" value={card.category.slug} />
      <input type="hidden" name="questionMeta" value={encodeQuestionMeta(answerableQuestions)} />

      {areaNotServed ? <AreaNotServed card={card} coverage={coverage} /> : null}

      {failure && !areaNotServed ? (
        <div className="notice cdash-notice-error" role="alert" data-testid="showcase-lead-error">
          {refusalText(failure)}
        </div>
      ) : null}

      <section className="showcase-lead-section">
        <h3>Talebiniz</h3>
        {answerableQuestions.length > 0 ? (
          <p className="pdash-form-hint">
            İşletmenin doğru değerlendirme yapabilmesi için {card.category.name} hizmetine özel
            soruları yanıtlayın.
          </p>
        ) : null}
        {answerableQuestions.map((question) => (
          <RequestField key={question.id} question={question} />
        ))}
        <DescriptionField
          question={descriptionQuestion}
          required
          placeholder="Ne yapılmasını istiyorsunuz?"
          helpText="İşi kısaca anlatın: ne, nerede, hangi durumda. İşletme buna göre dönüş yapar."
        />
      </section>

      <section className="showcase-lead-section">
        <h3>İşin yapılacağı yer</h3>
        <p className="pdash-form-hint">
          Bu hizmet yalnız {coverage} kapsamındaki işler için sunulur; kapsam dışındaysa
          talebinizi genel akıştan oluşturabilirsiniz.
        </p>
        <LocationFields
          provinces={provinces}
          initialValue={prefill}
          neighborhoodRequired={addressQuestion?.isRequired ?? false}
          neighborhoodHelpText={addressQuestion?.helpText}
          onChange={() => {
            // A new address is a new question; the last answer no longer applies.
            if (areaNotServed) setFailure(null);
          }}
        />
      </section>

      <section className="showcase-lead-section">
        <h3>Zamanlama</h3>
        <div className="form-grid">
          <UrgencySelect
            label="İşi ne zaman yaptırmak istiyorsunuz?"
            helpText="İşin kendisi için istediğiniz zaman."
            testId="showcase-lead-urgency"
          />
        </div>
        <fieldset className="pdash-form-row">
          <legend>İşletme size ne kadar sürede dönsün? *</legend>
          {/*
            Rendered from this card's own approved hours, never from a constant.
            Required with no default: a pre-ticked option would be the page
            choosing a deadline on the customer's behalf. The customer chooses
            by seeing the promise the business made.
          */}
          <label className="showcase-consent">
            <input
              type="radio"
              name="urgencyBucket"
              value="URGENT"
              required
              data-testid="showcase-urgency-urgent"
            />
            <span>Acil — {card.responseSlaUrgentHours} saat içinde dönüş</span>
          </label>
          <label className="showcase-consent">
            <input
              type="radio"
              name="urgencyBucket"
              value="NORMAL"
              required
              data-testid="showcase-urgency-normal"
            />
            <span>Normal — {card.responseSlaNormalHours} saat içinde dönüş</span>
          </label>
          <span className="help-text">
            Bu seçim işin zamanı değil, işletmenin size ilk dönüş süresidir.
          </span>
        </fieldset>
      </section>

      <section className="showcase-lead-section">
        <h3>İletişim</h3>
        <ContactSection
          accountContact={accountContact}
          useAlternateContact={useAlternateContact}
          onUseAlternateContactChange={(value) => {
            setUseAlternateContact(value);
            // A different person is a different number; the proof does not carry over.
            resetVerification();
          }}
          alternateContact={alternateContact}
          onAlternateContactChange={setAlternateContact}
          guestContact={guestContact}
          onGuestContactChange={setGuestContact}
          phoneLocked={phoneLocked}
          emailHelpText="Yanıt gelmezse size bu adresten yazacağız."
          phoneAddon={
            <PhoneProof
              phone={phone}
              state={verification}
              busy={pending}
              onSend={sendCode}
              onConfirm={confirmCode}
              onReset={resetVerification}
            />
          }
        />
      </section>

      <section className="showcase-lead-section">
        {showDisclosure ? (
          <ContactDisclosureField disclosure={disclosure} />
        ) : (
          <label className="showcase-consent">
            <input type="checkbox" name="contactDisclosureAccepted" value="true" />
            <span>
              Teklifi kabul ettiğimde iletişim bilgilerimin hizmet verenle paylaşılacağını kabul
              ediyorum.
            </span>
          </label>
        )}
      </section>

      <div className="pdash-form-foot">
        <Link className="pdash-btn pdash-btn-ghost" href={`/vitrin/${cardId}`}>
          Vazgeç
        </Link>
        <button
          className="pdash-btn pdash-btn-primary"
          type="submit"
          data-testid="showcase-lead-submit"
          disabled={!verified || submitBlocked || pending}
          title={
            !verified
              ? 'Göndermeden önce telefon numaranızı doğrulayın.'
              : submitBlocked
                ? 'Hesabınızdaki iletişim bilgileri eksik. Farklı bir iletişim kişisi tanımlayın.'
                : undefined
          }
        >
          {pending && verified ? 'Gönderiliyor…' : 'Talebi gönder'}
        </button>
        {!verified ? (
          <span className="help-text" data-testid="showcase-lead-submit-hint">
            Göndermeden önce telefon numaranızı doğrulayın.
          </span>
        ) : null}
      </div>
    </form>
  );
}

/**
 * The verification controls, rendered under the telephone number.
 *
 * Three states, one place: ask for a code, type the code, done. Every button is
 * `type="button"` — this sits inside the lead form, and none of these steps is
 * the submission. Enter inside the code field confirms the code rather than
 * posting the form for the same reason.
 */
function PhoneProof({
  phone,
  state,
  busy,
  onSend,
  onConfirm,
  onReset,
}: {
  phone: string;
  state: Verification;
  busy: boolean;
  onSend: () => void;
  onConfirm: (code: string) => void;
  onReset: () => void;
}) {
  const [code, setCode] = useState('');

  if (state.status === 'verified') {
    return (
      <div className="verify-well showcase-lead-proof" data-testid="showcase-lead-phone-verified">
        <span className="cdash-summary-label">Telefon doğrulandı</span>
        <p style={{ margin: 0, fontSize: 13 }}>
          {state.phone} numarası doğrulandı. Talebiniz bu numarayla işletmeye iletilecek.
        </p>
        <div className="inline-actions">
          <button type="button" className="pdash-btn pdash-btn-ghost" onClick={onReset}>
            Numarayı değiştir
          </button>
        </div>
      </div>
    );
  }

  if (state.status === 'code' || state.status === 'sending') {
    const sending = state.status === 'sending';
    const error = state.status === 'code' ? state.error : null;
    const verifying = state.status === 'code' && state.verifying;

    return (
      <div className="verify-well showcase-lead-proof" data-testid="showcase-lead-phone-code">
        <span className="cdash-summary-label">Telefon doğrulama</span>
        <p style={{ margin: 0, fontSize: 13 }}>
          {sending
            ? `${state.phone} numarasına kod gönderiliyor…`
            : state.phone
              ? `${state.phone} numarasına bir doğrulama kodu gönderdik. Kodu girin.`
              : null}
        </p>
        {error ? (
          <div className="notice cdash-notice-error" role="alert" data-testid="showcase-lead-phone-error">
            {error}
          </div>
        ) : null}
        <div className="verify-row">
          <label className="pdash-form-row" style={{ flex: '1 1 160px' }}>
            <span>Doğrulama kodu</span>
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              disabled={sending || !state.phone}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onConfirm(code);
                }
              }}
              data-testid="showcase-lead-code"
            />
          </label>
          <button
            type="button"
            className="pdash-btn pdash-btn-primary"
            disabled={busy || sending || verifying || !state.phone}
            onClick={() => onConfirm(code)}
            data-testid="showcase-lead-phone-verify"
          >
            {verifying ? 'Doğrulanıyor…' : 'Doğrula'}
          </button>
        </div>
        <div className="inline-actions">
          <button
            type="button"
            className="pdash-btn pdash-btn-ghost"
            disabled={busy || sending}
            onClick={onSend}
          >
            Kodu yeniden gönder
          </button>
          <button type="button" className="pdash-btn pdash-btn-ghost" onClick={onReset}>
            Numarayı değiştir
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="verify-well showcase-lead-proof" data-testid="showcase-lead-phone-idle">
      <span className="cdash-summary-label">Telefon doğrulama</span>
      <p style={{ margin: 0, fontSize: 13 }}>
        Talebiniz doğrudan bir işletmeye gideceği için önce telefon numaranızı doğrulamamız
        gerekiyor. Numaranıza tek kullanımlık bir kod göndereceğiz.
      </p>
      <div className="inline-actions">
        <button
          type="button"
          className="pdash-btn pdash-btn-primary"
          disabled={busy || !phone.trim()}
          onClick={onSend}
          data-testid="showcase-lead-phone-send"
        >
          Kod gönder
        </button>
      </div>
    </div>
  );
}

/**
 * What the customer is told when their address falls outside the card.
 *
 * The card is not the mistake and neither is the address; the pairing is. So
 * this says exactly that, in the API's own words, and then points at the route
 * that does work — the ordinary marketplace request, which reaches every
 * matching business in their district rather than this one. The form stays
 * below it: a customer who picked the wrong district can simply correct it.
 */
function AreaNotServed({ card, coverage }: { card: ShowcaseFeedCard; coverage: string }) {
  return (
    <div className="showcase-lead-refusal" data-testid="showcase-lead-area-not-served">
      <h3>Bu hizmet konumunuzu kapsamıyor</h3>
      <div className="notice cdash-notice-error" role="alert">
        Bu vitrin hizmeti seçtiğiniz konumu kapsamıyor. Genel talep oluşturmaya devam
        edebilirsiniz.
      </div>
      <p className="muted">
        {card.provider.businessName} bu kartı yalnız {coverage} için yayınladı.
        Talebiniz için bölgenizdeki tüm onaylı hizmet verenlerden teklif alabilir ya da aşağıda
        konumu düzeltip yeniden deneyebilirsiniz.
      </p>
      <div className="inline-actions">
        <Link
          className="pdash-btn pdash-btn-primary"
          href={`/categories/${card.category.slug}`}
          data-testid="showcase-general-request-cta"
        >
          Genel talep oluştur
        </Link>
        <Link className="pdash-btn pdash-btn-ghost" href="/vitrin">
          Vitrine dön
        </Link>
      </div>
    </div>
  );
}
