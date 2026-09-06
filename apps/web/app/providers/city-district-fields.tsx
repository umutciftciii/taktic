'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ProvinceWithDistricts } from '../../lib/locations';

type CityDistrictFieldsProps = {
  /** Every province with its districts, loaded by the page from the API. */
  provinces: ProvinceWithDistricts[];
  /** Form field names, so the two application forms post the keys the API reads. */
  cityName: string;
  districtName: string;
  labels: { city: ReactNode; district: ReactNode };
  /** Pre-selected values, for the edit screen. */
  defaultCity?: string;
  defaultDistrict?: string;
  classNames?: { field?: string; label?: string; select?: string };
  /** Told when a value changed, for a form that watches its own fields. */
  onChange?: () => void;
};

/**
 * Province and district, as two dependent selects — the business's own postal
 * address, and only that.
 *
 * It used to serve the service area as well, which is why it once had an
 * optional district. It does not any more: coverage is a list of areas at three
 * scopes and has its own editor in `service-area-fields.tsx`. An address is one
 * place and always names both levels, so both are required here.
 *
 * Free text is gone for the same reason it is gone everywhere else these names
 * are stored: they are compared against the canonical list as plain text, so a
 * typed "Kadikoy" is not slightly wrong, it is a place that does not exist.
 * Choosing from the shipped list makes that unreachable from the form, and the
 * API checks the same relation on its own because the endpoint takes a plain
 * JSON body.
 *
 * Native `<select>` elements, and the same field names as before — the server
 * actions read the form by those keys and are untouched.
 */
export function CityDistrictFields({
  provinces,
  cityName,
  districtName,
  labels,
  defaultCity = '',
  defaultDistrict = '',
  classNames,
  onChange,
}: CityDistrictFieldsProps) {
  const [city, setCity] = useState(defaultCity);
  const [district, setDistrict] = useState(defaultDistrict);

  // Held in a ref so the notify effect depends on the values only, and a caller
  // passing a fresh closure on every render cannot turn it into a loop.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    onChangeRef.current?.();
  }, [city, district]);

  const fieldClass = classNames?.field ?? 'pdash-form-row';
  const labelClass = classNames?.label;
  const selectClass = classNames?.select;
  const districts = provinces.find((province) => province.name === city)?.districts ?? [];

  return (
    <>
      <label className={fieldClass}>
        <span className={labelClass}>{labels.city}</span>
        <select
          className={selectClass}
          name={cityName}
          required
          value={city}
          onChange={(event) => {
            setCity(event.target.value);
            // The old district belongs to the old province; keeping it would
            // post a pair that does not exist.
            setDistrict('');
          }}
          data-testid={`location-city-${cityName}`}
        >
          <option value="">İl seçiniz</option>
          {provinces.map((province) => (
            <option key={province.code} value={province.name}>
              {province.name}
            </option>
          ))}
        </select>
      </label>

      <label className={fieldClass}>
        <span className={labelClass}>{labels.district}</span>
        <select
          className={selectClass}
          name={districtName}
          required
          disabled={!city}
          value={district}
          onChange={(event) => setDistrict(event.target.value)}
          data-testid={`location-district-${districtName}`}
        >
          <option value="">
            {city ? 'İlçe seçiniz' : 'Önce il seçiniz'}
          </option>
          {districts.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
