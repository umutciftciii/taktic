'use client';

import { useEffect, useRef, useState } from 'react';
import { SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH } from '@taktic/shared';
import type { Question } from '../../lib/api';

/**
 * Where the counter starts warning, in characters.
 *
 * Purely presentational — the rule itself is
 * SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH, which the API enforces. This only
 * decides when the customer is told they are running out of room, early enough
 * to be useful while there is still a paragraph left to write.
 */
const DESCRIPTION_NEAR_LIMIT_AT = 4500;

type DescriptionFieldProps = {
  /**
   * The category's DESCRIPTION-bound question, when it has one. It renames the
   * field and can make it mandatory; the value goes on living in the request's
   * own `description` column.
   */
  question?: Question | null;
  /** A form that always needs a description — the vitrin lead — says so here. */
  required?: boolean;
  placeholder?: string;
  /** Wording under the field when the category has none of its own. */
  helpText?: string;
  /** Told the new length on every input, for a parent that keeps a signal. */
  onLengthChange?: (length: number) => void;
};

/**
 * The description textarea with its character counter.
 *
 * One component for both request forms, because the limit, the counter and
 * the two warning thresholds are a single rule the customer should meet the
 * same way wherever they write a request.
 *
 * The textarea stays uncontrolled — the server action reads the posted field
 * — and only the length is mirrored into state, so the counter can render it.
 * React's onChange is the `input` event, which is what makes typing, deleting
 * and pasting all land here.
 */
export function DescriptionField({
  question,
  required = false,
  placeholder = 'Yapılacak işi kısaca anlatın: ne, nerede, hangi durumda.',
  helpText = 'Detay yazdıkça talebin kalite skoru yükselir ve daha isabetli teklif alırsınız.',
  onLengthChange,
}: DescriptionFieldProps) {
  const [length, setLength] = useState(0);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  /*
   * Browsers restore a textarea's text when the customer comes back to this
   * page — with the Back button, or from bfcache — but they do not re-run the
   * change handler that fed the count. Reading the field once on mount is what
   * stops the counter from claiming 0 under a description that is plainly
   * there. It only ever reads; the field stays uncontrolled.
   */
  useEffect(() => {
    if (fieldRef.current) {
      setLength(fieldRef.current.value.length);
    }
  }, []);

  /*
   * What the counter says beyond the bare numbers. Both states are spelled out
   * in words rather than signalled by colour alone, so the warning survives
   * greyscale, low vision and a screen reader.
   */
  const atLimit = length >= SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH;
  const nearLimit = !atLimit && length > DESCRIPTION_NEAR_LIMIT_AT;
  const status = atLimit ? 'Karakter sınırına ulaştınız' : nearLimit ? 'Sınıra yaklaşıyorsunuz' : null;

  return (
    <>
      <label className="form-row">
        <span>
          {question?.label ?? 'Açıklama'}
          {(question?.isRequired ?? required) ? ' *' : ''}
        </span>
        <textarea
          ref={fieldRef}
          name="description"
          required={question?.isRequired ?? required}
          data-testid="request-description"
          maxLength={SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH}
          aria-describedby="request-description-help request-description-counter"
          onChange={(event) => {
            setLength(event.target.value.length);
            onLengthChange?.(event.target.value.length);
          }}
          placeholder={placeholder}
        />
      </label>
      {/*
        * The help text and the counter share one row — guidance on the left,
        * the count on the right — because they answer the same question about
        * the field and reading them as two stacked lines made the count look
        * like a stray label.
        *
        * Both sit outside the label on purpose. A count that changes on every
        * keystroke inside it would keep rewriting the field's accessible name;
        * as descriptions they are announced when the field is reached, and the
        * status line — which only changes at the two thresholds, so it is not
        * chatty — announces itself.
        */}
      <div className="description-meta">
        <span className="help-text" id="request-description-help">
          {question?.helpText ?? helpText}
        </span>
        <p
          className="description-counter"
          id="request-description-counter"
          data-testid="request-description-counter"
          data-state={atLimit ? 'limit' : nearLimit ? 'near' : 'ok'}
        >
          <span className="description-counter-count">
            {length} / {SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH}
            <span className="visually-hidden"> karakter kullanıldı</span>
          </span>
          <span className="description-counter-status" role="status">
            {status}
          </span>
        </p>
      </div>
    </>
  );
}
