'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { serviceAreaLabel, serviceAreaRejectionReason } from '@taktic/shared';
import type { ProvinceWithDistricts } from '../../lib/locations';

export type ServiceAreaValue = {
  city: string;
  district: string | null;
  neighborhood: string | null;
};

type ServiceAreaFieldsProps = {
  /** Every province with its districts, rendered with the form. */
  provinces: ProvinceWithDistricts[];
  /** The areas the profile already has, for the edit screen. */
  defaultAreas?: ServiceAreaValue[];
  /** Class names, so the application form and the dashboard form keep theirs. */
  classNames?: { field?: string; label?: string; select?: string };
};

type NeighborhoodState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; names: string[] }
  | { status: 'unavailable' };

/**
 * Every area a provider covers, built one row at a time.
 *
 * This replaced a single province/district pair with a free-text neighbourhood
 * beside it. Both halves of that were wrong in the same way: a business that
 * works across three districts could only say one of them, and the one place
 * name it could type by hand was the one the matching rule compares as text —
 * so "Moda Mah." and "Moda" were two different neighbourhoods, and one of them
 * matched nothing.
 *
 * So: three dependent selects and an "Ekle" button. The province is required,
 * the district optional (leaving it means the whole province) and the
 * neighbourhood optional under a district — and each level is chosen from the
 * canonical list, never typed. What is added shows up as a removable chip
 * carrying the sentence the rest of the product prints for that scope.
 *
 * The two refusals — an area already there, and an area one side of which
 * swallows the other — are checked here so the provider is told before they
 * submit. They are not trusted: the API applies the same three rules to the
 * body it receives, and the database refuses a duplicate on its own.
 *
 * Each chosen area posts as one `serviceAreas` form entry holding its JSON, so
 * the server action reads them with `getAll` and the payload is a list rather
 * than three parallel arrays that could fall out of step.
 */
export function ServiceAreaFields({
  provinces,
  defaultAreas = [],
  classNames,
}: ServiceAreaFieldsProps) {
  const [areas, setAreas] = useState<ServiceAreaValue[]>(defaultAreas);
  const [city, setCity] = useState('');
  const [district, setDistrict] = useState('');
  const [neighborhood, setNeighborhood] = useState('');
  const [neighborhoods, setNeighborhoods] = useState<NeighborhoodState>({ status: 'idle' });
  const [error, setError] = useState<string | null>(null);

  const errorId = useId();
  const listId = useId();
  // Focus moves to the list after an area is added, so a keyboard user is told
  // what happened instead of being left on a button whose selects just cleared.
  const listRef = useRef<HTMLUListElement>(null);
  const justAdded = useRef(false);

  const districts = provinces.find((province) => province.name === city)?.districts ?? [];

  useEffect(() => {
    if (!city || !district) {
      setNeighborhoods({ status: 'idle' });
      return;
    }

    // Aborted when the pair changes again before the answer arrives, so a slow
    // response for a district already moved off cannot repopulate the list.
    const controller = new AbortController();
    setNeighborhoods({ status: 'loading' });

    const query = `city=${encodeURIComponent(city)}&district=${encodeURIComponent(district)}`;
    fetch(`/api/locations/neighborhoods?${query}`, { signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<string[]>) : Promise.reject()))
      .then((names) => setNeighborhoods({ status: 'ready', names }))
      .catch(() => {
        if (controller.signal.aborted) return;
        setNeighborhoods({ status: 'unavailable' });
      });

    return () => controller.abort();
  }, [city, district]);

  useEffect(() => {
    if (!justAdded.current) return;
    justAdded.current = false;
    listRef.current?.focus();
  }, [areas]);

  const neighborhoodOptions = neighborhoods.status === 'ready' ? neighborhoods.names : [];

  function addArea() {
    if (!city) {
      setError('Önce bir il seçin.');
      return;
    }

    const candidate: ServiceAreaValue = {
      city,
      district: district || null,
      neighborhood: district ? neighborhood || null : null,
    };

    const reason = serviceAreaRejectionReason(areas, candidate);
    if (reason) {
      setError(reason);
      return;
    }

    setError(null);
    setAreas((current) => [...current, candidate]);
    justAdded.current = true;
    setCity('');
    setDistrict('');
    setNeighborhood('');
  }

  function removeArea(index: number) {
    setError(null);
    setAreas((current) => current.filter((_, position) => position !== index));
  }

  const fieldClass = classNames?.field ?? 'pdash-form-row';
  const labelClass = classNames?.label;
  const selectClass = classNames?.select;

  return (
    <div className="service-areas">
      {/*
        One entry per area. The API derives the scope from the levels, so the
        payload carries the three names and nothing a client could contradict.
      */}
      {areas.map((area) => (
        <input
          key={serviceAreaLabel(area)}
          type="hidden"
          name="serviceAreas"
          value={JSON.stringify(area)}
        />
      ))}

      <div className="service-areas-picker">
        <label className={fieldClass}>
          <span className={labelClass}>İl</span>
          <select
            className={selectClass}
            value={city}
            onChange={(event) => {
              setCity(event.target.value);
              // The old district belongs to the old province; keeping it would
              // name a pair that does not exist.
              setDistrict('');
              setNeighborhood('');
              setError(null);
            }}
            data-testid="service-area-city"
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
          <span className={labelClass}>İlçe</span>
          <select
            className={selectClass}
            value={district}
            disabled={!city}
            onChange={(event) => {
              setDistrict(event.target.value);
              setNeighborhood('');
              setError(null);
            }}
            data-testid="service-area-district"
          >
            <option value="">{city ? 'Tüm il' : 'Önce il seçiniz'}</option>
            {districts.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <label className={fieldClass}>
          <span className={labelClass}>Mahalle</span>
          <select
            className={selectClass}
            value={neighborhood}
            disabled={!district || neighborhoodOptions.length === 0}
            onChange={(event) => {
              setNeighborhood(event.target.value);
              setError(null);
            }}
            data-testid="service-area-neighborhood"
          >
            <option value="">{neighborhoodPlaceholder(district, neighborhoods)}</option>
            {neighborhoodOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <div className={fieldClass}>
          <span className={labelClass} aria-hidden="true" />
          <button
            type="button"
            className="service-areas-add"
            onClick={addArea}
            aria-describedby={error ? errorId : listId}
            data-testid="service-area-add"
          >
            Bölge ekle
          </button>
        </div>
      </div>

      {error ? (
        <p className="service-areas-error" id={errorId} role="alert" data-testid="service-area-error">
          {error}
        </p>
      ) : null}

      <ul
        className="service-areas-list"
        id={listId}
        ref={listRef}
        tabIndex={-1}
        aria-label="Eklenen hizmet bölgeleri"
        data-testid="service-area-list"
      >
        {areas.length === 0 ? (
          <li className="service-areas-empty">
            Henüz bölge eklemediniz. En az bir hizmet bölgesi gerekir.
          </li>
        ) : (
          areas.map((area, index) => (
            <li className="service-areas-chip" key={serviceAreaLabel(area)}>
              <span>{serviceAreaLabel(area)}</span>
              <button
                type="button"
                className="service-areas-remove"
                onClick={() => removeArea(index)}
                aria-label={`${serviceAreaLabel(area)} bölgesini kaldır`}
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function neighborhoodPlaceholder(district: string, state: NeighborhoodState): string {
  if (!district) return 'Önce ilçe seçiniz';
  if (state.status === 'loading') return 'Yükleniyor...';
  if (state.status === 'unavailable') return 'Liste getirilemedi';
  if (state.status === 'ready' && state.names.length === 0) return 'Kayıtlı mahalle yok';
  return 'Tüm ilçe';
}
