'use client';

import { useState } from 'react';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../lib/password-policy';

/**
 * Password inputs with the criteria ticked as they are met.
 *
 * A reading of what is in the two boxes and nothing else: the values never
 * leave the component — not to a log, a query string or an analytics call — and
 * the server still decides whether the password is accepted on submit.
 */
export function PasswordFields() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const criteria = [
    {
      key: 'length',
      label: `En az ${PASSWORD_MIN_LENGTH} karakter`,
      met: password.length >= PASSWORD_MIN_LENGTH,
    },
    {
      key: 'match',
      label: 'Şifreler eşleşiyor',
      met: password.length > 0 && password === confirm,
    },
  ];

  return (
    <>
      <label className="form-row">
        <span>Yeni şifre</span>
        <input
          name="password"
          type="password"
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          required
          autoComplete="new-password"
          placeholder={`En az ${PASSWORD_MIN_LENGTH} karakter`}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <label className="form-row">
        <span>Şifre tekrarı</span>
        <input
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

      <ul className="password-criteria" data-testid="password-criteria">
        {criteria.map((criterion) => (
          <li
            key={criterion.key}
            className={`password-criterion${criterion.met ? ' is-met' : ''}`}
            data-testid={`password-criterion-${criterion.key}`}
            data-met={criterion.met ? 'true' : 'false'}
          >
            <span className="password-criterion-mark" aria-hidden="true">
              {criterion.met ? '✓' : ''}
            </span>
            <span>{criterion.label}</span>
            <span className="password-criterion-state">
              {criterion.met ? ' (karşılandı)' : ' (henüz karşılanmadı)'}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
