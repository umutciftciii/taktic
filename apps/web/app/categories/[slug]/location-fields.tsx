'use client';

import { useEffect, useRef, useState } from 'react';
import type { ProvinceWithDistricts } from '../../../lib/locations';

type LocationFieldsProps = {
  /** Every province with its districts, rendered with the form. */
  provinces: ProvinceWithDistricts[];
  /** Told when a value changed, so the form can refresh its own signals. */
  onChange?: () => void;
};

type NeighborhoodState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; names: string[] }
  | { status: 'unavailable' };

/**
 * Province, district and neighbourhood, as three dependent selects.
 *
 * Free text is gone on purpose. These three fields are not decoration: provider
 * matching keys on city and district, so a typo used to produce a request no
 * provider in that district could ever be shown. Choosing from the canonical
 * list makes an unmatched spelling impossible from the form — and the API
 * checks the same relation on its own, because the endpoint is public.
 *
 * The dependency runs one way. A district can only be picked once a province
 * is, and a neighbourhood once a district is; changing a parent clears what
 * hung off it rather than leaving an orphan behind. The field names, and so the
 * payload the server action posts, are exactly what they were.
 *
 * Native `<select>` elements: keyboard operable, screen-reader labelled and
 * type-ahead searchable in the browser's own locale-aware way, which is what a
 * list of Turkish place names needs.
 */
export function LocationFields({ provinces, onChange }: LocationFieldsProps) {
  const [city, setCity] = useState('');
  const [district, setDistrict] = useState('');
  const [neighborhood, setNeighborhood] = useState('');
  const [neighborhoods, setNeighborhoods] = useState<NeighborhoodState>({ status: 'idle' });

  // Held in a ref so the notify effect depends on the values only, and a caller
  // passing a fresh closure on every render cannot turn it into a loop.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const districts = provinces.find((province) => province.name === city)?.districts ?? [];

  useEffect(() => {
    if (!city || !district) {
      setNeighborhoods({ status: 'idle' });
      return;
    }

    // Aborted when the pair changes again before the answer arrives, so a slow
    // response for a district the customer has already moved off can never
    // repopulate the list under them.
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

  /*
   * After the render, not during the change event.
   *
   * The form's own quality estimate reads these fields out of the DOM, and
   * clearing a dependent select is a state update React has not applied yet
   * while the event is still being handled: told then, the estimate would
   * still see the district that was just cleared.
   */
  useEffect(() => {
    onChangeRef.current?.();
  }, [city, district, neighborhood]);

  function handleCityChange(value: string) {
    setCity(value);
    // The old district belongs to the old province; keeping it would post a
    // pair that does not exist.
    setDistrict('');
    setNeighborhood('');
  }

  function handleDistrictChange(value: string) {
    setDistrict(value);
    setNeighborhood('');
  }

  const neighborhoodOptions = neighborhoods.status === 'ready' ? neighborhoods.names : [];

  return (
    <div className="form-grid">
      <label className="form-row">
        <span>İl *</span>
        <select
          name="city"
          required
          value={city}
          onChange={(event) => handleCityChange(event.target.value)}
          data-testid="request-city"
        >
          <option value="">İl seçiniz</option>
          {provinces.map((province) => (
            <option key={province.code} value={province.name}>
              {province.name}
            </option>
          ))}
        </select>
      </label>

      <label className="form-row">
        <span>İlçe *</span>
        <select
          name="district"
          required
          value={district}
          disabled={!city}
          onChange={(event) => handleDistrictChange(event.target.value)}
          data-testid="request-district"
        >
          <option value="">{city ? 'İlçe seçiniz' : 'Önce il seçiniz'}</option>
          {districts.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>

      <label className="form-row">
        <span>Mahalle</span>
        <select
          name="neighborhood"
          value={neighborhood}
          disabled={!district || neighborhoodOptions.length === 0}
          onChange={(event) => setNeighborhood(event.target.value)}
          data-testid="request-neighborhood"
        >
          <option value="">{neighborhoodPlaceholder(district, neighborhoods)}</option>
          {neighborhoodOptions.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <span className="help-text">
          {neighborhoods.status === 'unavailable'
            ? 'Mahalle listesi şu anda getirilemedi. Mahalle isteğe bağlıdır; adres notuna yazabilirsiniz.'
            : 'İsteğe bağlı.'}
        </span>
      </label>
    </div>
  );
}

function neighborhoodPlaceholder(district: string, state: NeighborhoodState): string {
  if (!district) return 'Önce ilçe seçiniz';
  if (state.status === 'loading') return 'Yükleniyor...';
  if (state.status === 'unavailable') return 'Liste getirilemedi';
  if (state.status === 'ready' && state.names.length === 0) return 'Kayıtlı mahalle yok';
  return 'Mahalle seçiniz (isteğe bağlı)';
}
