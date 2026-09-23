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
 * CMP-006 PR-B: a provider whose purchases can enter the refund flow also sees
 * a topic choice. `refundOptions` is null for everybody else and whenever the
 * API says the flow is closed — then the form is exactly the general one, with
 * no hint that a refund topic exists. Choosing the refund topic swaps the
 * subject field (the server writes that subject) for a picker of the
 * provider's own PAID packages; ones that do not meet the normal rules are
 * shown, disabled, with the reason.
 */
export function NewTicketForm({ refundOptions = null }: { refundOptions?: PackageRefundOptions | null }) {
  const [state, formAction, pending] = useActionState<SupportTicketFormState, FormData>(
    createSupportTicketAction,
    { status: 'idle' },
  );

  const refundAvailable = Boolean(refundOptions?.available);
  const [topic, setTopic] = useState<Topic>(
    refundAvailable && state.topic === 'PACKAGE_AND_CREDIT_REFUND' ? 'PACKAGE_AND_CREDIT_REFUND' : 'GENERAL',
  );
  const [purchaseId, setPurchaseId] = useState(state.packagePurchaseId ?? '');
  const [subject, setSubject] = useState(state.subject ?? '');
  const [body, setBody] = useState(state.body ?? '');

  const isRefund = refundAvailable && topic === 'PACKAGE_AND_CREDIT_REFUND';
  const subjectRemaining = SUPPORT_TICKET_SUBJECT_MAX_LENGTH - subject.length;
  const bodyRemaining = SUPPORT_TICKET_MESSAGE_MAX_LENGTH - body.length;
  const purchases = refundOptions?.purchases ?? [];
  const hasSelectable = purchases.some((purchase) => purchase.selectable);

  const ready = isRefund
    ? purchaseId.length > 0 && body.trim().length > 0
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
          <legend className="field-label">Konu türü *</legend>
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
              <span>Genel</span>
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
        <fieldset className="field" data-testid="refund-purchase-picker" aria-describedby="refund-explanation">
          <legend className="field-label">İade istediğiniz paket *</legend>
          <p className="help-text" id="refund-explanation">
            {PACKAGE_REFUND_FORM_EXPLANATION}
          </p>
          <div className="provider-choice-group">
            {purchases.map((purchase) => {
              const selected = purchaseId === purchase.id;
              const className = [
                'provider-choice',
                selected ? 'is-selected' : '',
                purchase.selectable ? '' : 'is-disabled',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <label
                  key={purchase.id}
                  className={className}
                  data-testid="refund-purchase-option"
                  data-selectable={purchase.selectable ? 'true' : 'false'}
                >
                  <input
                    className="provider-choice-input"
                    type="radio"
                    name="packagePurchaseId"
                    value={purchase.id}
                    checked={selected}
                    disabled={!purchase.selectable}
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
                    {purchase.selectable && purchase.windowEndsAt ? (
                      <span className="help-text">Son talep günü: {formatDate(purchase.windowEndsAt)}</span>
                    ) : null}
                    {purchase.notes.map((note) => (
                      <span key={note} className="help-text" data-testid="refund-purchase-note">
                        {note}
                      </span>
                    ))}
                  </span>
                </label>
              );
            })}
          </div>
          {!hasSelectable ? (
            <p className="cdash-notice" data-testid="refund-none-selectable">
              Şu anda normal iade koşullarını sağlayan bir paketiniz yok.
            </p>
          ) : null}
          <p className="help-text">{PACKAGE_REFUND_FALLBACK_HINT}</p>
        </fieldset>
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
