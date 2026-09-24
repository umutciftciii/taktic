'use client';

import { useActionState, useState } from 'react';
import {
  SUPPORT_TICKET_MESSAGE_MAX_LENGTH,
  SUPPORT_TICKET_SUBJECT_MAX_LENGTH,
} from '@taktic/shared';
import type { PackageRefundOptions } from '../../lib/api';
import { formatDate, formatDateTime, formatPrice } from '../../lib/formatters';
import {
  PACKAGE_REFUND_FALLBACK_HINT,
  PACKAGE_REFUND_FORM_EXPLANATION,
  PACKAGE_REFUND_TEST_ENVIRONMENT_NOTICE,
} from '../../lib/package-refund';
import { createSupportTicketAction, type SupportTicketFormState } from './actions';

type Topic = 'GENERAL' | 'PACKAGE_AND_CREDIT_REFUND';

/**
 * The form that opens a ticket.
 *
 * A plain form posting a server action, enhanced rather than replaced by this
 * component: the two counters and the pending label are what the client adds,
 * and with scripting off the ticket is still opened by the same action.
 *
 * The two `maxLength` attributes carry the same numbers the API enforces —
 * both sides read `packages/shared/limits.json` — so the browser can never stop
 * somebody the server would have accepted, or accept text the counter has
 * already reported as over the line.
 *
 * CMP-006 PR-B / PR-B.1: a provider with at least one purchase a refund
 * request can be opened for also sees a "Talep türü" choice. `refundOptions`
 * is null for everybody else and whenever the API says the flow is closed or
 * nothing is requestable — then the form is exactly the general one, with no
 * hint that a refund type exists. The list holds only what the API listed:
 * the caller's own, requestable purchases; nothing here decides eligibility.
 * On the refund type the subject is not a field: the server writes it, and
 * the form shows the one it will write. `initialRefund` / `initialPurchaseId`
 * come from the purchase page's link, already checked against that list.
 */
export function NewTicketForm({
  refundOptions = null,
  initialRefund = false,
  initialPurchaseId = '',
}: {
  refundOptions?: PackageRefundOptions | null;
  initialRefund?: boolean;
  initialPurchaseId?: string;
}) {
  const [state, formAction, pending] = useActionState<SupportTicketFormState, FormData>(
    createSupportTicketAction,
    { status: 'idle' },
  );

  const refundAvailable = Boolean(refundOptions?.available);
  const purchases = refundOptions?.purchases ?? [];
  const listed = (id: string | undefined) => Boolean(id) && purchases.some((purchase) => purchase.id === id);
  const [topic, setTopic] = useState<Topic>(
    refundAvailable && (state.topic === 'PACKAGE_AND_CREDIT_REFUND' || initialRefund)
      ? 'PACKAGE_AND_CREDIT_REFUND'
      : 'GENERAL',
  );
  const [purchaseId, setPurchaseId] = useState(
    listed(state.packagePurchaseId) ? state.packagePurchaseId! : listed(initialPurchaseId) ? initialPurchaseId : '',
  );
  const [subject, setSubject] = useState(state.subject ?? '');
  const [body, setBody] = useState(state.body ?? '');

  const isRefund = refundAvailable && topic === 'PACKAGE_AND_CREDIT_REFUND';
  const subjectRemaining = SUPPORT_TICKET_SUBJECT_MAX_LENGTH - subject.length;
  const bodyRemaining = SUPPORT_TICKET_MESSAGE_MAX_LENGTH - body.length;
  const selected = purchases.find((purchase) => purchase.id === purchaseId) ?? null;

  const ready = isRefund
    ? selected !== null && body.trim().length > 0
    : subject.trim().length > 0 && body.trim().length > 0;

  return (
    <form className="cdash-account-form" action={formAction} data-testid="support-new-form">
      {/*
        The refusal is announced rather than only drawn: somebody who submitted
        with the keyboard is not necessarily looking at the top of the form.
      */}
      {state.status === 'error' && state.message ? (
        <div className="notice cdash-notice-error" role="alert" data-testid="support-form-error">
          <span>{state.message}</span>
        </div>
      ) : null}

      {refundAvailable ? (
        <fieldset className="field" data-testid="support-topic">
          <legend className="field-label">Talep türü *</legend>
          <div className="inline-actions">
            <label className="radio">
              <input
                type="radio"
                name="topic"
                value="GENERAL"
                checked={topic === 'GENERAL'}
                onChange={() => setTopic('GENERAL')}
                data-testid="support-topic-general"
              />
              <span className="dot" aria-hidden="true" />
              <span>Genel destek</span>
            </label>
            <label className="radio">
              <input
                type="radio"
                name="topic"
                value="PACKAGE_AND_CREDIT_REFUND"
                checked={topic === 'PACKAGE_AND_CREDIT_REFUND'}
                onChange={() => setTopic('PACKAGE_AND_CREDIT_REFUND')}
                data-testid="support-topic-refund"
              />
              <span className="dot" aria-hidden="true" />
              <span>Paket ve kredi iadesi</span>
            </label>
          </div>
        </fieldset>
      ) : null}

      {isRefund ? (
        <>
          {refundOptions?.testMode ? (
            <p className="cdash-notice" data-testid="refund-test-environment">
              <strong>{PACKAGE_REFUND_TEST_ENVIRONMENT_NOTICE}</strong>
            </p>
          ) : null}
          <fieldset className="field" data-testid="refund-purchase-picker" aria-describedby="refund-explanation">
            <legend className="field-label">İade istediğiniz paket *</legend>
            <p className="help-text" id="refund-explanation">
              {PACKAGE_REFUND_FORM_EXPLANATION}
            </p>
            <div className="provider-choice-group">
              {purchases.map((purchase) => {
                const checked = purchaseId === purchase.id;
                return (
                  <label
                    key={purchase.id}
                    className={checked ? 'provider-choice is-selected' : 'provider-choice'}
                    data-testid="refund-purchase-option"
                    data-purchase-id={purchase.id}
                  >
                    <input
                      className="provider-choice-input"
                      type="radio"
                      name="packagePurchaseId"
                      value={purchase.id}
                      checked={checked}
                      onChange={() => setPurchaseId(purchase.id)}
                    />
                    <span className="provider-choice-mark" aria-hidden="true" />
                    <span className="provider-choice-body">
                      <span className="provider-choice-name">{purchase.packageName}</span>
                      <span className="help-text">
                        {purchase.purchaseNumber ? `${purchase.purchaseNumber} · ` : ''}
                        {formatPrice(purchase.priceAmount, purchase.currency)} · {purchase.creditAmount} kredi
                      </span>
                      {purchase.paidAt ? (
                        <span className="help-text">Ödeme: {formatDateTime(purchase.paidAt)}</span>
                      ) : null}
                      {purchase.windowEndsAt ? (
                        <span className="help-text">Son talep günü: {formatDate(purchase.windowEndsAt)}</span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="help-text">{PACKAGE_REFUND_FALLBACK_HINT}</p>
          </fieldset>

          {/*
            The subject of a refund ticket is the server's, written from the
            purchase. It is shown, not sent: there is no input to edit and no
            field named "subject" in this form on this type.
          */}
          <div className="field" data-testid="refund-fixed-subject">
            <span className="field-label">Konu</span>
            <p className="field-control" aria-readonly="true" data-testid="refund-fixed-subject-text">
              {selected ? selected.ticketSubject : 'Paket seçtiğinizde konu otomatik oluşturulur.'}
            </p>
            <small className="help-text">Konu sistem tarafından belirlenir ve değiştirilemez.</small>
          </div>
        </>
      ) : (
        <label className="field" htmlFor="support-subject">
          <span className="field-label">Konu *</span>
          <input
            id="support-subject"
            className="field-control"
            name="subject"
            type="text"
            required
            maxLength={SUPPORT_TICKET_SUBJECT_MAX_LENGTH}
            autoComplete="off"
            data-testid="support-subject-input"
            aria-describedby="support-subject-count"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
          <small className="help-text" id="support-subject-count" aria-live="polite">
            {subjectRemaining} karakter kaldı
          </small>
        </label>
      )}

      <label className="field" htmlFor="support-message">
        <span className="field-label">{isRefund ? 'İade gerekçeniz *' : 'Mesajınız *'}</span>
        <textarea
          id="support-message"
          className="msg-composer-input"
          name="message"
          rows={6}
          required
          maxLength={SUPPORT_TICKET_MESSAGE_MAX_LENGTH}
          placeholder={
            isRefund
              ? 'Paketi neden iade etmek istediğinizi kısaca anlatın.'
              : 'Yaşadığınız sorunu olabildiğince açık anlatın.'
          }
          data-testid="support-message-input"
          aria-describedby="support-message-count"
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        <small className="help-text" id="support-message-count" aria-live="polite">
          {bodyRemaining} karakter kaldı
        </small>
      </label>

      <div className="inline-actions">
        <button
          className="cdash-btn cdash-btn-primary"
          type="submit"
          data-testid="support-submit"
          disabled={pending || !ready}
        >
          {pending ? 'Gönderiliyor…' : isRefund ? 'İade talebini gönder' : 'Destek talebi oluştur'}
        </button>
      </div>
    </form>
  );
}
