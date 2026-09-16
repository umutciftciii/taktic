'use client';

import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type RefObject,
} from 'react';
import type {
  ContactDisclosureConfig,
  Question,
  RouterSelection,
  ShowcaseFeedCard,
} from '../../../lib/api';
import { DRAFT_STATE_FIELD, draftStateFor } from '../../../lib/draft-state';
import type { ProvinceWithDistricts } from '../../../lib/locations';
import type { RequestDraftPayload } from '../../../lib/request-drafts';
import { boundQuestion, encodeRouterSelections, visibleQuestions } from '../../../lib/request-flow';
import {
  CONTACT_DETAILS_ERROR,
  contactDetailsTarget,
  type ContactDetailsTarget,
} from '../../../lib/contact-details-refusal';
import { REQUEST_REFUSAL_GENERIC, requestRefusalText } from '../../../lib/request-refusal-text';
import { switchAccountAction } from '../../login/actions';
import {
  ContactSection,
  EMPTY_ALTERNATE_CONTACT,
  accountContactIsComplete,
  type AccountContact,
} from '../../request-fields/contact-section';
import { DescriptionField } from '../../request-fields/description-field';
import { ContactDisclosureField } from '../../request-fields/disclosure-field';
import { useIdentityCheck } from '../../request-fields/identity-check';
import { TurnstileSlot, useTurnstile } from '../../request-fields/turnstile';
import {
  TURNSTILE_ACTIONS,
  TURNSTILE_CHALLENGE_FAILED,
  turnstileHeaders,
  type TurnstileWebConfig,
} from '../../../lib/turnstile';
import { IdentityNotice } from '../../request-fields/identity-notice';
import { LocationFields } from '../../request-fields/location-fields';
import { RequestField, encodeQuestionMeta, readAnswers } from '../../request-fields/question-field';
import { TimingFields } from '../../request-fields/timing-fields';
import {
  handOffToShowcaseAction,
  saveMarketplaceDraftAction,
  type SubmitRequestResult,
} from '../actions';
import { BudgetFields } from './budget-fields';
import { ShowcaseMatches, type HandOffFailure } from './showcase-matches';
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
  /**
   * The server action that posts the request. It answers rather than
   * redirects, so a refusal can be shown inline with everything the customer
   * typed still on screen; the component navigates on success.
   */
  action: (formData: FormData, turnstileToken: string | null) => Promise<SubmitRequestResult>;
  /**
   * How the Turnstile widget is rendered on this stack — read by the page from
   * the server's environment at request time. See lib/turnstile.ts.
   */
  turnstile: TurnstileWebConfig;
  /**
   * A draft the customer parked before leaving to sign in or activate an
   * account, restored into the fields. Null when there is nothing to restore.
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

const STEPS = [
  { key: 'contact', label: 'İletişim' },
  { key: 'detail', label: 'İş detayı' },
  { key: 'place', label: 'Konum & zaman' },
] as const;

/** Which of the two ways off the contact step a saved draft was for. */
type DraftIntent = 'login' | 'activate';

/**
 * The public request form, in the three steps the design defines.
 *
 * Contact comes first. A visitor's telephone number and e-mail are checked
 * against the customer records before anything else is asked, so that
 * somebody who already has an account is sent to sign in *before* writing the
 * request rather than after — and what they had typed is parked as a draft and
 * restored when they come back. A signed-in customer has a resolved identity
 * already and walks straight through.
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
  turnstile: turnstileConfig,
  initialDraft = null,
  wrongAccount = false,
  formPath,
}: RequestFormProps) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const contactRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const placeRef = useRef<HTMLDivElement>(null);
  const stepRefs: ReadonlyArray<RefObject<HTMLDivElement | null>> = [
    contactRef,
    detailRef,
    placeRef,
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
  const [place, setPlace] = useState({
    city: initialDraft?.city ?? '',
    district: initialDraft?.district ?? '',
    neighborhood: initialDraft?.neighborhood ?? '',
  });

  /*
   * Whether the customer asked to name somebody else, and what they typed.
   * Controlled state, owned here and rendered by the shared ContactSection —
   * see its notes on why the values are erased rather than hidden.
   */
  const [useAlternateContact, setUseAlternateContact] = useState(false);
  const [alternateContact, setAlternateContact] = useState(EMPTY_ALTERNATE_CONTACT);

  /*
   * The visitor's own three fields, controlled, because the identity pre-check
   * has to know what was typed without reading the DOM. Never part of a draft:
   * the number and address are what the draft is bound to, not what it holds.
   */
  const [guestContact, setGuestContact] = useState(EMPTY_ALTERNATE_CONTACT);

  /*
   * The Turnstile adapter, one per form. Every protected call below — the
   * identity check, the activation link, the submission — asks it for a fresh
   * token first; the token goes into that one call's header and nowhere else.
   */
  const turnstile = useTurnstile(turnstileConfig);
  const acquireIdentityToken = useCallback(
    () => turnstile.acquire(TURNSTILE_ACTIONS.identityCheck),
    [turnstile.acquire],
  );

  /*
   * The gate on the contact step. A visitor's number and e-mail are checked
   * once all three fields are filled and left; only a `new-customer` answer
   * opens the way forward. For a signed-in customer the check is disabled and
   * the gate stands open — their identity is the session's, already resolved.
   */
  const identity = useIdentityCheck({
    ...guestContact,
    enabled: accountContact === null,
    acquireToken: acquireIdentityToken,
  });

  /*
   * The two ways off the contact step for somebody who already has an account,
   * and what parking the draft for either of them said.
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

  /** The API's refusal of the last submission, shown inline until the next try. */
  const [failure, setFailure] = useState<Extract<SubmitRequestResult, { ok: false }> | null>(null);
  const [submitting, startSubmit] = useTransition();

  /*
   * The business the customer chose to address the request to, or null for
   * the ordinary marketplace request. One form value: choosing changes what
   * the primary button does, never what has been typed. See ShowcaseMatches.
   */
  const [selectedCard, setSelectedCard] = useState<ShowcaseFeedCard | null>(null);
  const [handOffFailure, setHandOffFailure] = useState<HandOffFailure | null>(null);
  const [handOffDraftExists, setHandOffDraftExists] = useState(false);
  const [handingOff, startHandOff] = useTransition();
  /** "Hesap değiştir" — a server action that redirects, so it runs in a transition. */
  const [, startSwitch] = useTransition();

  /*
   * A restored draft is already in the fields when the form first renders, but
   * nothing has fired a change event: the estimate and the conditional
   * questions are read from the DOM once, so they reflect what came back
   * rather than an empty form. Reading only — see `refreshSignals`.
   */
  const restoredDraft = initialDraft !== null;
  useEffect(() => {
    if (restoredDraft) refreshSignals();
  }, [restoredDraft]);

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
    const form = formRef.current;
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

      /*
       * Leaving the contact step needs the gate open, not merely valid fields.
       * Nothing on this screen can open it but the check itself — so if it has
       * not answered yet (autofill skips blur; the customer clicked straight
       * through), the click runs it, and the notice under the e-mail field
       * says what happened. A visitor who must sign in is stopped here, before
       * writing the request.
       */
      if (step === 0 && !identity.gateOpen) {
        identity.check();
        return;
      }
    }

    refreshSignals();
    setStep(index);
  }

  const isLast = step === STEPS.length - 1;

  /**
   * Posts the form and shows the answer here.
   *
   * `onSubmit` rather than `<form action>`: a refusal has to land beside what
   * the customer typed, with every field still holding it. The server action
   * answers with the id on success and the component navigates.
   */
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    // The gate stands until the check said `new-customer`; a visitor cannot
    // reach this step otherwise, but submit is where the rule finally holds.
    if (!identity.gateOpen) return;
    if (submitBlocked || submitting || handingOff) return;
    // With a business chosen the primary button is not a submit at all, but an
    // Enter key in a field still reaches here: the request is never posted to
    // the market behind a choice that said otherwise.
    if (selectedCard) return;

    setFailure(null);
    // Read before the transition: React resets nothing here, but the token is
    // asked for per submission and the FormData must not carry it.
    const data = new FormData(form);
    startSubmit(async () => {
      let result: SubmitRequestResult;
      try {
        const token = await turnstile.acquire(TURNSTILE_ACTIONS.serviceRequestCreate);
        result = await action(data, token);
      } catch (error) {
        if (error instanceof Error && error.message === TURNSTILE_CHALLENGE_FAILED) {
          // The widget could not produce a token: nothing was sent. Said in
          // the banner like any other refusal, with "tekrar deneyin".
          setFailure({ ok: false, code: TURNSTILE_CHALLENGE_FAILED, message: null });
          return;
        }
        // The action itself never throws — it answers every refusal — so this
        // is the transport: a dropped connection, a deploy mid-flight. Said
        // inline like any other failure rather than handed to the error page.
        console.error('[request] submit: transport failure', error);
        result = { ok: false, code: REQUEST_REFUSAL_GENERIC, message: null };
      }
      if (result.ok) {
        // The action already cleared the draft cookie; nothing else to undo.
        // Only the id travels: the success page reads the request's real
        // state from the API rather than from a flag this form would set.
        router.push(`/requests/success?id=${encodeURIComponent(result.requestId)}`);
        return;
      }
      setFailure(result);
      // A refusal about one field is shown under that field, which may sit on
      // a step the customer has already left. Go back to it, so the sentence
      // is on screen and not behind a hidden panel.
      const target = contactDetailsTarget(
        result,
        answerableQuestions.map((question) => question.key),
      );
      if (target) setStep(target.target === 'addressNote' ? 2 : 1);
    });
  }

  /**
   * "Seçili işletmeye devam et": parks the form as a draft keyed on the chosen
   * card and moves to that business's vitrin form, which restores it. Nothing
   * is posted to the market. Every refusal lands beside the cards, with the
   * form untouched; a card that has gone off the air also drops the choice, so
   * the button is a submit again and the general request is one click away.
   */
  function handOff(replace: boolean) {
    const form = formRef.current;
    const card = selectedCard;
    if (!form || !card || handingOff) return;
    if (step === 2 && !stepIsValid(2)) return;

    setHandOffFailure(null);
    setHandOffDraftExists(false);
    startHandOff(async () => {
      const data = new FormData(form);
      if (replace) data.set('replaceDraft', 'true');
      let result: Awaited<ReturnType<typeof handOffToShowcaseAction>>;
      try {
        result = await handOffToShowcaseAction(data, { cardId: card.cardId, categoryId });
      } catch (error) {
        console.error('[request] hand-off: transport failure', error);
        result = { ok: false, code: 'DRAFT_FAILED' };
      }
      if (result.ok) {
        router.push(result.href);
        return;
      }
      if (result.code === 'DRAFT_EXISTS') {
        setHandOffDraftExists(true);
        return;
      }
      if (result.code === 'CARD_UNAVAILABLE') setSelectedCard(null);
      setHandOffFailure(result.code);
    });
  }

  /**
   * The field the last refusal was about, when it was about one. Everything
   * else — the banner above the steps, the other fields — reads `null`.
   */
  const refusedField: ContactDetailsTarget | null = failure
    ? contactDetailsTarget(failure, answerableQuestions.map((question) => question.key))
    : null;
  const fieldError = (target: ContactDetailsTarget['target'], questionKey?: string) => {
    if (!refusedField || refusedField.target !== target) return null;
    if (refusedField.target === 'answer' && refusedField.questionKey !== questionKey) return null;
    return CONTACT_DETAILS_ERROR;
  };

  /**
   * Parks the form before the customer leaves it. Answers whether they may go;
   * every refusal is shown in the identity notice and nothing navigates.
   */
  async function saveDraft(replace: boolean): Promise<boolean> {
    const form = formRef.current;
    if (!form) return false;
    setDraftBusy(true);
    try {
      const result = await saveMarketplaceDraftAction(new FormData(form), replace);
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
      const token = await turnstile.acquire(TURNSTILE_ACTIONS.identityActivate);
      const response = await fetch('/api/auth/request-identity-check/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...turnstileHeaders(token) },
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

  /** "Vazgeç": the earlier draft stays as it is; nothing here is saved or sent. */
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
    startSwitch(async () => {
      await switchAccountAction(formPath);
    });
  }

  const identityBusy = draftBusy || submitting;
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

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="form-card" onChange={refreshSignals}>
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
      {/* What the page found in the draft slot — decides whether a success clears the cookie. */}
      <input
        type="hidden"
        name={DRAFT_STATE_FIELD}
        value={draftStateFor({ restored: restoredDraft, wrongAccount })}
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

          {/*
            The parked draft belongs to another account: said once, above the
            steps, with the way to the right account. The form below is empty.
          */}
          {wrongAccount ? <IdentityNotice {...noticeProps} wrongAccount /> : null}

          {/*
            The API's refusal of the last submission — a conflict on the contact
            fields, a validation message — inline and above the steps, with every
            field still holding what was typed.
          */}
          {failure && !refusedField ? (
            <div className="notice cdash-notice-error" role="alert" data-testid="request-submit-error">
              {requestRefusalText(failure)}
            </div>
          ) : null}

          <div
            id="request-step-contact"
            ref={contactRef}
            className="step-panel"
            hidden={step !== 0}
          >
            <section className="form-section">
              <h2>İletişim</h2>

              <ContactSection
                accountContact={accountContact}
                useAlternateContact={useAlternateContact}
                onUseAlternateContactChange={setUseAlternateContact}
                alternateContact={alternateContact}
                onAlternateContactChange={setAlternateContact}
                guestContact={guestContact}
                onGuestContactChange={setGuestContact}
                onContactBlur={identity.check}
                identityNotice={<IdentityNotice {...noticeProps} wrongAccount={false} />}
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

          <div
            id="request-step-detail"
            ref={detailRef}
            className="step-panel"
            hidden={step !== 1}
          >
            {answerableQuestions.length > 0 ? (
              <section className="form-section">
                <h2>Talep detayları</h2>
                <p className="form-section-subtitle">
                  Hizmet verenlerin doğru teklif verebilmesi için kategoriye özel soruları
                  yanıtlayın.
                </p>
                {answerableQuestions.map((question) => (
                  <RequestField
                    key={question.id}
                    question={question}
                    defaultValue={draftAnswer(question.key)}
                    error={fieldError('answer', question.key)}
                  />
                ))}
              </section>
            ) : null}

            <section className="form-section">
              <h2>İş açıklaması</h2>
              <DescriptionField
                question={descriptionQuestion}
                defaultValue={initialDraft?.description}
                error={fieldError('description')}
              />
            </section>
          </div>

          <div
            id="request-step-place"
            ref={placeRef}
            className="step-panel"
            hidden={step !== 2}
          >
            <section className="form-section">
              <h2>Konum</h2>
              <LocationFields
                provinces={provinces}
                initialValue={initialDraft ?? undefined}
                onChange={(value) => {
                  setPlace(value);
                  refreshSignals();
                }}
                neighborhoodRequired={addressQuestion?.isRequired ?? false}
                neighborhoodHelpText={addressQuestion?.helpText}
              />
              <label className="form-row">
                <span>Adres notu</span>
                <textarea
                  name="addressNote"
                  placeholder="Ek bilgi / yol tarifi"
                  defaultValue={initialDraft?.addressNote}
                  aria-invalid={fieldError('addressNote') ? true : undefined}
                />
                {fieldError('addressNote') ? (
                  <span className="field-error" role="alert" data-testid="contact-details-error">
                    {fieldError('addressNote')}
                  </span>
                ) : null}
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
              selected={selectedCard}
              onSelect={(card) => {
                setSelectedCard(card);
                setHandOffFailure(null);
                setHandOffDraftExists(false);
              }}
              guest={accountContact === null}
              failure={handOffFailure}
              draftExists={handOffDraftExists}
              onReplaceDraft={() => handOff(true)}
              onKeepDraft={() => setHandOffDraftExists(false)}
              busy={handingOff}
            />

            <section className="form-section">
              <h2>Zaman ve bütçe</h2>
              <div className="form-grid">
                <TimingFields
                  dateQuestion={preferredDateQuestion}
                  defaultUrgency={initialDraft?.urgency}
                  defaultStart={initialDraft?.preferredDate}
                  defaultEnd={initialDraft?.preferredDateEnd}
                  onChange={refreshSignals}
                />
                <BudgetFields
                  minLabel={budgetQuestion?.label ?? 'Minimum bütçe'}
                  required={budgetQuestion?.isRequired ?? false}
                  minHelpText={budgetQuestion?.helpText}
                  onChange={refreshSignals}
                  defaultMin={initialDraft?.budgetMin}
                  defaultMax={initialDraft?.budgetMax}
                />
              </div>
            </section>
          </div>

          {/*
            The Turnstile widget's place: outside the step panels, so a
            challenge that needs the customer is drawn on whichever step is
            showing — the contact step's identity check and the last step's
            submission both run through it.
          */}
          <TurnstileSlot turnstile={turnstile} />

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
            {isLast && selectedCard ? (
              /*
                A business is chosen: the primary action leaves for its vitrin
                form instead of posting to the market. `type="button"` on
                purpose — this must never submit — and its own key, so React
                cannot recycle the node into the submit button below mid-click.
              */
              <button
                key="handoff"
                type="button"
                className="btn btn-primary"
                onClick={() => handOff(false)}
                disabled={handingOff}
                aria-busy={handingOff || undefined}
                data-testid="request-handoff-cta"
              >
                {handingOff ? 'Aktarılıyor…' : 'Seçili işletmeye devam et'}
                <IconArrowRight />
              </button>
            ) : isLast ? (
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
                disabled={submitBlocked || submitting}
                aria-busy={submitting || undefined}
                title={
                  submitBlocked
                    ? 'Hesabınızdaki iletişim bilgileri eksik. Farklı bir iletişim kişisi tanımlayın.'
                    : undefined
                }
              >
                {submitting ? 'Gönderiliyor…' : 'Talebi Gönder'}
                <IconArrowRight />
              </button>
            ) : (
              /*
                Off the contact step only through the gate — see `goTo`. Held
                while the check is in flight so a second click cannot start a
                second one; a click before any check runs the first.
              */
              <button
                key="next"
                type="button"
                className="btn btn-primary"
                onClick={() => goTo(step + 1)}
                disabled={step === 0 && identity.status === 'checking'}
                aria-disabled={step === 0 && !identity.gateOpen ? true : undefined}
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
