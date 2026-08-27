'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ProvinceWithDistricts } from '../../lib/locations';

type CityDistrictFieldsProps = {
  /** Every province with its districts, loaded by the page from the API. */
  provinces: ProvinceWithDistricts[];
  /** Form field names, so one component serves both the address and the area. */
  cityName: string;
  districtName: string;
  labels: { city: ReactNode; district: ReactNode };
  /** Pre-selected values, for the edit screen. */
  defaultCity?: string;
  defaultDistrict?: string;
  /** The address requires a district; a service area may name a province alone. */
  districtRequired?: boolean;
  /** What the district placeholder says when no district is chosen. */
  districtPlaceholder?: string;
  classNames?: { field?: string; label?: string; select?: string };
  /** Told when a value changed, for a form that watches its own fields. */
  onChange?: () => void;
};

/**
 * Province and district, as two dependent selects.
 *
 * A provider's address and service area used to be free text, and the service
 * area is what discovery matches a request against — as plain text, in
 * `matchesProviderArea`. So a provider who typed "Kadikoy" was not slightly
 * wrong: they were invisible to every request in Kadıköy, with nothing on any
 * screen to say why. Choosing from the canonical list makes that unreachable
 * from the form, and the API checks the same relation on its own because the
 * endpoint takes a plain JSON body.
 *
 * Two levels rather than the request form's three: provider matching keys on
 * city and district, so a neighbourhood here would be data the product does not
 * read.
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
  districtRequired = true,
  districtPlaceholder,
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
          required={districtRequired}
          disabled={!city}
          value={district}
          onChange={(event) => setDistrict(event.target.value)}
          data-testid={`location-district-${districtName}`}
        >
          <option value="">
            {city ? (districtPlaceholder ?? 'İlçe seçiniz') : 'Önce il seçiniz'}
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
