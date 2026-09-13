'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition, type FormEvent } from 'react';
import type { ContactDisclosureConfig, Question, ShowcaseFeedCard } from '../../../lib/api';
import type { ProvinceWithDistricts } from '../../../lib/locations';
import { DRAFT_STATE_FIELD, draftStateFor } from '../../../lib/draft-state';
import { discardRequestDraftAction, type RequestDraftPayload } from '../../../lib/request-drafts';
import { boundQuestion, visibleQuestions } from '../../../lib/request-flow';
import { REQUEST_REFUSAL_GENERIC, requestRefusalText } from '../../../lib/request-refusal-text';
import { switchAccountAction } from '../../login/actions';
import {
  ContactSection,
  EMPTY_ALTERNATE_CONTACT,
  accountContactIsComplete,
  type AccountContact,
  type AlternateContact,
} from '../../request-fields/contact-section';
import { DescriptionField } from '../../request-fields/description-field';
import { ContactDisclosureField } from '../../request-fields/disclosure-field';
import { useIdentityCheck } from '../../request-fields/identity-check';
import { IdentityNotice } from '../../request-fields/identity-notice';
import { LocationFields } from '../../request-fields/location-fields';
import { RequestField, encodeQuestionMeta, readAnswers } from '../../request-fields/question-field';
import { UrgencySelect } from '../../request-fields/timing-fields';
import {
  confirmShowcaseLeadVerificationAction,
  createShowcaseLeadAction,
  saveShowcaseDraftAction,
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

/** The sentence for a refusal — see requestRefusalText for the precedence. */
function refusalText(failure: Extract<LeadActionResult, { ok: false }>): string {
  return requestRefusalText(failure);
}

type Verification =
  | { status: 'idle' }
  | { status: 'sending'; phone: string }
  | { status: 'code'; phone: string; error: string | null; verifying: boolean }
  | { status: 'verified'; phone: string };

/** Which of the two ways off the contact section a saved draft was for. */
type DraftIntent = 'login' | 'activate';

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
  /**
   * A draft the customer parked before leaving to sign in or activate an
   * account, restored into the fields. Null when there is nothing to restore.
   * When there is one it wins over `prefill`: the draft is what they actually
   * filled in, the query string only where they came from.
   */
  initialDraft?: RequestDraftPayload | null;
  /**
   * The parked draft belongs to a different account than the one signed in
   * now. The form opens empty and says so; the draft is not shown.
   */
  wrongAccount?: boolean;
  /**
   * This screen's own path, query included — what sign-in and activation are
   * told to come back to.
   */
  formPath: string;
};

/**
 * The form that writes to the business behind a vitrin card.
 *
 * ## Contact first, and a gate before the SMS
 *
 * The contact section opens the form. A visitor's number and e-mail are
 * checked against the customer records the moment all three fields are
 * filled and left, and only a `new-customer` answer opens the gate: somebody
 * who already has an account is sent to sign in (their form parked as a draft
 * and restored when they come back) *before* a verification code is sent to
 * their number and before they write the request. A registered person never
 * receives the SMS. A signed-in customer has a resolved identity already and
 * the gate stands open for them.
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
  initialDraft = null,
  wrongAccount = false,
  formPath,
}: LeadFormProps) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  /** "Hesap değiştir" and "Vazgeç" — server actions that navigate, so they run in their own transition. */
  const [leaving, startLeave] = useTransition();

  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [guestContact, setGuestContact] = useState<AlternateContact>({
    ...EMPTY_ALTERNATE_CONTACT,
    phone: prefill.phone,
  });
  const [useAlternateContact, setUseAlternateContact] = useState(false);
  const [alternateContact, setAlternateContact] = useState(EMPTY_ALTERNATE_CONTACT);
  const [verification, setVerification] = useState<Verification>({ status: 'idle' });
  const [failure, setFailure] = useState<Extract<LeadActionResult, { ok: false }> | null>(null);

  /*
   * The gate on the contact section. A visitor's number and e-mail are checked
   * once all three fields are filled and left; only a `new-customer` answer
   * opens the way to the code and to submit. For a signed-in customer the check
   * is disabled and the gate stands open — their identity is the session's.
   */
  const identity = useIdentityCheck({ ...guestContact, enabled: accountContact === null });

  /*
   * The two ways off the contact section for somebody who already has an
   * account, and what parking the draft for either of them said.
   */
  const [draftIntent, setDraftIntent] = useState<DraftIntent | null>(null);
  const [draftExists, setDraftExists] = useState(false);
  const [draftError, setDraftError] = useState<
    'DRAFT_BUSY' | 'DRAFT_FAILED' | 'ACTIVATION_FAILED' | null
  >(null);
  const [activationSent, setActivationSent] = useState(false);
  const [draftBusy, setDraftBusy] = useState(false);

  /*
   * A changed number or address is a different identity: whatever the last
   * one was told — a draft conflict, a failed park, a link already sent — no
   * longer describes this one. The check's own answer resets the same way
   * inside the hook.
   */
  const { phone: guestPhone, email: guestEmail } = guestContact;
  useEffect(() => {
    setDraftError(null);
    setDraftExists(false);
    setActivationSent(false);
    setDraftIntent(null);
  }, [guestPhone, guestEmail]);

  /*
   * A restored draft is already in the fields when the form first renders, but
   * nothing has fired a change event: the answers are read from the DOM once so
   * a dependent question the draft answered is shown rather than hidden.
   */
  const restoredDraft = initialDraft !== null;
  useEffect(() => {
    const form = formRef.current;
    if (restoredDraft && form) setAnswers(readAnswers(form, questions));
  }, [restoredDraft, questions]);

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
  const gateOpen = identity.gateOpen;

  function resetVerification() {
    setVerification({ status: 'idle' });
  }

  function sendCode() {
    // No code before the gate: a number that belongs to an account is sent to
    // sign in, not an SMS. The button is disabled too; this is where the rule holds.
    if (!gateOpen) return;
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
    if (!gateOpen || !verified || submitBlocked) return;

    const data = new FormData(event.currentTarget);
    setFailure(null);
    startTransition(async () => {
      let result: LeadActionResult | undefined;
      try {
        result = await createShowcaseLeadAction(data);
      } catch (error) {
        // The action answers every refusal itself, so this is the transport: a
        // dropped connection, a deploy mid-flight. Said inline like any other.
        console.error('[vitrin lead] submit: transport failure', error);
        result = { ok: false, code: REQUEST_REFUSAL_GENERIC, message: null };
      }
      // On success the action redirects and the router is already navigating;
      // the promise resolves with nothing to show.
      if (!result || result.ok) return;
      setFailure(result);
      // A proof that lapsed while the form was being filled in has to be
      // made again; leaving "verified" on screen would invite a second
      // refusal for the same reason.
      if (result.code === PHONE_PROOF_REQUIRED) {
        resetVerification();
      }
    });
  }

  /**
   * Parks the form before the customer leaves it. Answers whether they may go;
   * every refusal is shown in the identity notice and nothing navigates.
   */
  async function saveDraft(replace: boolean): Promise<boolean> {
    const form = formRef.current;
    if (!form) return false;
    setDraftBusy(true);
    try {
      const result = await saveShowcaseDraftAction(new FormData(form), replace);
      if (result.ok) {
        setDraftExists(false);
        setDraftError(null);
        return true;
      }
      if (result.code === 'DRAFT_EXISTS') {
        setDraftExists(true);
      } else if (result.code === 'DRAFT_NOT_CONTINUABLE') {
        // The customer record changed under us; ask again and act on the new answer.
        identity.check();
      } else {
        setDraftError(result.code);
      }
      return false;
    } catch {
      setDraftError('DRAFT_FAILED');
      return false;
    } finally {
      setDraftBusy(false);
    }
  }

  /** A full navigation on purpose: sign-in sets a cookie and this page re-reads the draft. */
  function goToLogin() {
    window.location.assign(`/login?redirectTo=${encodeURIComponent(formPath)}`);
  }

  /**
   * Asks for the activation link. The proxy answers 202 whatever it found — a
   * form that could tell "sent" from "no such account" would be an oracle for
   * which numbers have an account — so a 202 is "sent". Anything else (a
   * throttle, an unreachable API, a dropped connection) is a failure the
   * customer is told about and may retry; it is never reported as sent.
   */
  async function sendActivation() {
    setDraftBusy(true);
    try {
      const response = await fetch('/api/auth/request-identity-check/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          phone: guestContact.phone.trim(),
          email: guestContact.email.trim(),
          redirectTo: formPath,
        }),
      });
      if (!response.ok) throw new Error(String(response.status));
      setActivationSent(true);
    } catch {
      setDraftError('ACTIVATION_FAILED');
    } finally {
      setDraftBusy(false);
    }
  }

  /** Continues with whatever the draft was parked for. */
  async function continueAfterDraft(intent: DraftIntent) {
    if (intent === 'login') goToLogin();
    else await sendActivation();
  }

  async function onLogin() {
    setDraftIntent('login');
    if (await saveDraft(false)) goToLogin();
  }

  async function onActivate() {
    setDraftIntent('activate');
    if (await saveDraft(false)) await sendActivation();
  }

  /** "Evet, geç": the earlier draft gives way to this one, then the same road. */
  async function onReplaceDraft() {
    const intent = draftIntent ?? 'login';
    if (await saveDraft(true)) await continueAfterDraft(intent);
  }

  /** "Vazgeç" in the draft-exists notice: the earlier draft stays as it is; nothing here is saved or sent. */
  function onKeepDraft() {
    setDraftExists(false);
    setDraftIntent(null);
  }

  /*
   * "Hesap değiştir": ends the session and returns to sign-in, this form as
   * the destination. A server action, so the sign-out is a POST. The parked
   * draft is left alone — it is the other account's to continue.
   */
  function onChangeAccount() {
    startLeave(async () => {
      await switchAccountAction(formPath);
    });
  }

  /*
   * "Vazgeç" under the form: the explicit way out. The draft this form
   * actually opened — and only that one — is discarded on the server and its
   * cookie dropped, then back to the card's own page. A form that opened no
   * draft (nothing parked, or a draft protected for another account) just
   * leaves: the row the cookie names is not this form's to delete, and the
   * API would refuse anyway. Distinct from the keep-draft "Vazgeç" above,
   * which discards nothing.
   */
  function onDiscard() {
    startLeave(async () => {
      if (restoredDraft) {
        try {
          await discardRequestDraftAction({ formType: 'SHOWCASE_LEAD', categorySlug: card.category.slug, cardId });
        } catch (error) {
          // Best effort: the draft expires on its own; leaving is not withheld for it.
          console.error('[vitrin lead] discard draft failed', error);
        }
      }
      router.push(`/vitrin/${encodeURIComponent(cardId)}`);
    });
  }

  const identityBusy = draftBusy || pending || leaving;
  const noticeProps = {
    status: identity.status,
    onRetry: () => {
      setDraftError(null);
      if (draftError && draftIntent) {
        // The retry after a failed park or a failed link repeats the same road.
        if (draftIntent === 'login') void onLogin();
        else void onActivate();
        return;
      }
      identity.retry();
    },
    onLogin,
    onActivate,
    activationSent,
    draftError,
    draftExists,
    onReplaceDraft: () => void onReplaceDraft(),
    onKeepDraft,
    onChangeAccount,
    busy: identityBusy,
  };

  /** A saved draft's answer for one question, when there is one. */
  const draftAnswer = (questionKey: string) =>
    initialDraft?.answers?.find((answer) => answer.questionKey === questionKey)?.value;

  const areaNotServed = failure?.code === AREA_NOT_SERVED;

  /*
   * Why submit is withheld, in the order the rules apply: the gate first (no
   * code and no request before the contact check), then the proof, then the
   * one case the API would refuse anyway.
   */
  const submitHint = !gateOpen
    ? 'Göndermeden önce iletişim bilgilerinizin kontrolü tamamlanmalı.'
    : !verified
      ? 'Göndermeden önce telefon numaranızı doğrulayın.'
      : submitBlocked
        ? 'Hesabınızdaki iletişim bilgileri eksik. Farklı bir iletişim kişisi tanımlayın.'
        : null;

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
      {/* What the page found in the draft slot — decides whether a success clears the cookie. */}
      <input type="hidden" name={DRAFT_STATE_FIELD} value={draftStateFor({ restored: restoredDraft, wrongAccount })} />

      {/*
        The parked draft belongs to another account: said once, above the
        form, with the way to the right account. The form below is empty.
      */}
      {wrongAccount ? <IdentityNotice {...noticeProps} wrongAccount /> : null}

      {areaNotServed ? <AreaNotServed card={card} coverage={coverage} /> : null}

      {failure && !areaNotServed ? (
        <div className="notice cdash-notice-error" role="alert" data-testid="showcase-lead-error">
          {refusalText(failure)}
        </div>
      ) : null}

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
          onContactBlur={identity.check}
          identityNotice={<IdentityNotice {...noticeProps} wrongAccount={false} />}
          phoneLocked={phoneLocked}
          emailHelpText="Yanıt gelmezse size bu adresten yazacağız."
          phoneAddon={
            <PhoneProof
              phone={phone}
              state={verification}
              busy={pending}
              gateOpen={gateOpen}
              onSend={sendCode}
              onConfirm={confirmCode}
              onReset={resetVerification}
            />
          }
        />
      </section>

      <section className="showcase-lead-section">
        <h3>Talebiniz</h3>
        {answerableQuestions.length > 0 ? (
          <p className="pdash-form-hint">
            İşletmenin doğru değerlendirme yapabilmesi için {card.category.name} hizmetine özel
            soruları yanıtlayın.
          </p>
        ) : null}
        {answerableQuestions.map((question) => (
          <RequestField
            key={question.id}
            question={question}
            defaultValue={draftAnswer(question.key)}
          />
        ))}
        <DescriptionField
          question={descriptionQuestion}
          required
          placeholder="Ne yapılmasını istiyorsunuz?"
          helpText="İşi kısaca anlatın: ne, nerede, hangi durumda. İşletme buna göre dönüş yapar."
          defaultValue={initialDraft?.description}
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
          /* The draft wins over the query string: it is what was actually filled in. */
          initialValue={
            initialDraft
              ? {
                  city: initialDraft.city,
                  district: initialDraft.district,
                  neighborhood: initialDraft.neighborhood,
                }
              : prefill
          }
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
            defaultValue={initialDraft?.urgency}
          />
        </div>
        <fieldset className="pdash-form-row">
          <legend>İşletme size ne kadar sürede dönsün? *</legend>
          {/*
            Rendered from this card's own approved hours, never from a constant.
            Required with no default: a pre-ticked option would be the page
            choosing a deadline on the customer's behalf. The customer chooses
            by seeing the promise the business made — and a restored draft
            only repeats the choice they already made.
          */}
          <label className="showcase-consent">
            <input
              type="radio"
              name="urgencyBucket"
              value="URGENT"
              required
              defaultChecked={initialDraft?.urgencyBucket === 'URGENT'}
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
              defaultChecked={initialDraft?.urgencyBucket === 'NORMAL'}
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
        <button
          type="button"
          className="pdash-btn pdash-btn-ghost"
          onClick={onDiscard}
          disabled={leaving}
          data-testid="showcase-lead-discard"
        >
          Vazgeç
        </button>
        <button
          className="pdash-btn pdash-btn-primary"
          type="submit"
          data-testid="showcase-lead-submit"
          disabled={!gateOpen || !verified || submitBlocked || pending}
          title={submitHint ?? undefined}
        >
          {pending && verified && gateOpen ? 'Gönderiliyor…' : 'Talebi gönder'}
        </button>
        {submitHint && (!gateOpen || !verified) ? (
          <span className="help-text" data-testid="showcase-lead-submit-hint">
            {submitHint}
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
 *
 * "Kod gönder" waits for the identity gate: a number that already belongs to
 * an account is sent to sign in, and never receives a code from here.
 */
function PhoneProof({
  phone,
  state,
  busy,
  gateOpen,
  onSend,
  onConfirm,
  onReset,
}: {
  phone: string;
  state: Verification;
  busy: boolean;
  gateOpen: boolean;
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
            disabled={busy || sending || !gateOpen}
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
          disabled={busy || !phone.trim() || !gateOpen}
          onClick={onSend}
          title={!gateOpen ? 'Önce iletişim bilgilerinizin kontrolü tamamlanmalı.' : undefined}
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
