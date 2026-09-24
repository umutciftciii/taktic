'use client';

import { useState } from 'react';
import {
  BUSINESS_REGISTRATION_INPUT_MAX_LENGTH,
  BUSINESS_REGISTRATION_TYPE_ORDER,
  NONE_DECLARED,
  businessRegistrationHint,
  businessRegistrationLabel,
  type BusinessRegistrationType,
} from '../../lib/business-registration';

type BusinessRegistrationFieldsProps = {
  /** Pre-selected type, for the company-information screen. */
  defaultType?: BusinessRegistrationType | null;
  classNames: { field: string; label: string; input: string; help?: string; required?: string };
};

/**
 * The canonical business registration pair (CMP-006 PR-C): a type — required,
 * "Beyan etmiyorum" included — and the number that type needs. Choosing
 * "Beyan etmiyorum" hides the number and posts none. The number is never
 * pre-filled: the API hands out only its masked form, and replacing a
 * registration means typing it again.
 */
export function BusinessRegistrationFields({ defaultType = null, classNames }: BusinessRegistrationFieldsProps) {
  const [type, setType] = useState<BusinessRegistrationType | ''>(defaultType ?? '');
  const needsNumber = type !== '' && type !== NONE_DECLARED;
  const hint = type ? businessRegistrationHint(type) : null;

  return (
    <>
      <label className={classNames.field}>
        <span className={classNames.label}>
          İşletme kaydı türü {classNames.required ? <span className={classNames.required}>*</span> : null}
        </span>
        <select
          className={classNames.input}
          name="businessRegistrationType"
          required
          value={type}
          onChange={(event) => setType(event.target.value as BusinessRegistrationType | '')}
        >
          <option value="" disabled>
            Seçin
          </option>
          {BUSINESS_REGISTRATION_TYPE_ORDER.map((option) => (
            <option key={option} value={option}>
              {businessRegistrationLabel(option)}
            </option>
          ))}
        </select>
        {type === NONE_DECLARED ? (
          <span className={classNames.help}>
            Başvurunuz yine alınır; promosyonlar için kaydınız bir ekip üyesi tarafından incelenir.
          </span>
        ) : null}
      </label>
      {needsNumber ? (
        <label className={classNames.field}>
          <span className={classNames.label}>
            Kayıt numarası {classNames.required ? <span className={classNames.required}>*</span> : null}
          </span>
          <input
            className={classNames.input}
            name="businessRegistrationNumber"
            required
            inputMode="numeric"
            autoComplete="off"
            maxLength={BUSINESS_REGISTRATION_INPUT_MAX_LENGTH}
            placeholder={hint ?? undefined}
          />
          <span className={classNames.help}>
            {hint ? `${hint}. ` : ''}Numaranız yalnızca son iki hanesi görünecek şekilde saklanır.
          </span>
        </label>
      ) : null}
    </>
  );
}
