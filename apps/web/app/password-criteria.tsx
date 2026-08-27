'use client';

import { useState } from 'react';
import { IconCheck } from './landing-icons';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../lib/password-policy';

type PasswordFieldsProps = {
  /** Rendered with a confirmation field, and the matching criterion with it. */
  withConfirm?: boolean;
  labels?: { password?: string; confirm?: string };
  /** Class names of the surrounding screen, so this fits admin and web alike. */
  classNames?: { field?: string; label?: string; input?: string };
};

/**
 * Password inputs with the criteria shown, and ticked as they are met.
 *
 * Purely a reading of what has been typed: nothing is sent anywhere, nothing is
 * stored, and neither the password nor anything derived from it leaves this
 * component — no logging, no query string, no analytics. Submission is still
 * validated by the server, which remains the only thing that decides whether a
 * password is accepted.
 */
export function PasswordFields({
  withConfirm = true,
  labels,
  classNames,
}: PasswordFieldsProps) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const fieldClass = classNames?.field ?? 'auth-screen-field';
  const labelClass = classNames?.label ?? 'auth-screen-label';
  const inputClass = classNames?.input ?? 'auth-screen-input';

  const criteria = [
    { key: 'length', label: `En az ${PASSWORD_MIN_LENGTH} karakter`, met: password.length >= PASSWORD_MIN_LENGTH },
    ...(withConfirm
      ? [{ key: 'match', label: 'Şifreler eşleşiyor', met: password.length > 0 && password === confirm }]
      : []),
  ];

  return (
    <>
      <label className={fieldClass}>
        <span className={labelClass}>{labels?.password ?? 'Yeni şifre'}</span>
        <input
          className={inputClass}
          name="password"
          type="password"
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          required
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder={`En az ${PASSWORD_MIN_LENGTH} karakter`}
        />
      </label>

      {withConfirm ? (
        <label className={fieldClass}>
          <span className={labelClass}>{labels?.confirm ?? 'Şifre tekrarı'}</span>
          <input
            className={inputClass}
            name="passwordConfirm"
            type="password"
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </label>
      ) : null}

      <ul className="password-criteria" data-testid="password-criteria">
        {criteria.map((criterion) => (
          <li
            key={criterion.key}
            className={`password-criterion${criterion.met ? ' is-met' : ''}`}
            data-testid={`password-criterion-${criterion.key}`}
            data-met={criterion.met ? 'true' : 'false'}
          >
            <span className={`check-square${criterion.met ? '' : ' check-square-idle'}`} aria-hidden="true">
              {criterion.met ? <IconCheck size={10} /> : null}
            </span>
            <span>{criterion.label}</span>
            {/* Announced rather than left to colour and a tick alone. */}
            <span className="cdash-visually-hidden">
              {criterion.met ? ' (karşılandı)' : ' (henüz karşılanmadı)'}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
