'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { ProvinceWithDistricts } from '../../lib/locations';

type LocationFieldsProps = {
  /** Every province with its districts, rendered with the form. */
  provinces: ProvinceWithDistricts[];
  /**
   * Told when a value changed, and what the three fields now hold.
   *
   * The values travel because the form has a second reader of them: the vitrin
   * block, which asks "who could take this exact job" and needs the category
   * and the place to ask it. They are passed rather than re-read from the DOM
   * because two of the three are React-controlled here, and a caller reading
   * them out of the form during a change event would see the value that was
   * just cleared.
   */
  onChange?: (value: { city: string; district: string; neighborhood: string }) => void;
  /**
   * Whether the neighbourhood has to be chosen.
   *
   * SERVICE-AREA-001: every ON_SITE request — and a HYBRID one the customer
   * wants on site — turns it on; the API refuses such a request without one.
   * A REMOTE request leaves it off. Off is also the default, for any caller
   * that names a place without matching on it.
   *
   * Required means the form cannot be submitted without a neighbourhood while
   * the list is loading or failed to load (it offers a retry instead). The one
   * exception is the API's own: a district whose list is really empty has
   * nothing to pick, and the request goes through district-wide.
   */
  neighborhoodRequired?: boolean;
  /** Category-specific wording for the neighbourhood field, when there is any. */
  neighborhoodHelpText?: string | null;
  /**
   * Where the selects start.
   *
   * The vitrin card's form is reached from the marketplace form with the place
   * the customer already chose there, and asking it a third time would be
   * rude. A prefill is a convenience and nothing more: a value the lists do
   * not contain simply leaves the select on its placeholder, and the API
   * re-checks whatever is posted.
   */
  initialValue?: { city?: string; district?: string; neighborhood?: string };
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
export function LocationFields({
  provinces,
  onChange,
  neighborhoodRequired = false,
  neighborhoodHelpText,
  initialValue,
}: LocationFieldsProps) {
  const [city, setCity] = useState(initialValue?.city ?? '');
  const [district, setDistrict] = useState(initialValue?.district ?? '');
  const [neighborhood, setNeighborhood] = useState(initialValue?.neighborhood ?? '');
  const [neighborhoods, setNeighborhoods] = useState<NeighborhoodState>({ status: 'idle' });
  // Bumped by "Tekrar dene": re-runs the fetch for the same pair.
  const [attempt, setAttempt] = useState(0);
  const neighborhoodSelectRef = useRef<HTMLSelectElement>(null);
  const neighborhoodId = useId();

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
  }, [city, district, attempt]);

  /*
   * After the render, not during the change event.
   *
   * The form's own quality estimate reads these fields out of the DOM, and
   * clearing a dependent select is a state update React has not applied yet
   * while the event is still being handled: told then, the estimate would
   * still see the district that was just cleared.
   */
  useEffect(() => {
    onChangeRef.current?.({ city, district, neighborhood });
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
  // A district whose list really is empty — the API's one exception. Not a
  // failure: there is nothing to pick, so nothing is asked.
  const districtHasNoNeighborhoods = neighborhoods.status === 'ready' && neighborhoodOptions.length === 0;
  const required = neighborhoodRequired && Boolean(district) && !districtHasNoNeighborhoods;
  /*
   * While the list is loading or failed to load, a required select stays
   * enabled with only its placeholder: a disabled control is skipped by
   * constraint validation, and this one has to stop the step and the submit.
   */
  const blockedMessage = !required
    ? ''
    : neighborhoods.status === 'unavailable'
      ? 'Mahalle listesi getirilemedi. Listeyi yeniden yükleyip mahallenizi seçin.'
      : neighborhoods.status === 'loading' || neighborhoods.status === 'idle'
        ? 'Mahalle listesi yükleniyor. Lütfen bekleyin.'
        : '';

  useEffect(() => {
    neighborhoodSelectRef.current?.setCustomValidity(blockedMessage);
  }, [blockedMessage]);

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

      <div className="form-row">
        <label className="field-label" htmlFor={neighborhoodId}>
          Mahalle{required ? ' *' : ''}
        </label>
        <select
          ref={neighborhoodSelectRef}
          id={neighborhoodId}
          name="neighborhood"
          required={required}
          value={neighborhood}
          disabled={!district || (neighborhoodOptions.length === 0 && !required)}
          onChange={(event) => setNeighborhood(event.target.value)}
          aria-describedby={`${neighborhoodId}-help`}
          data-testid="request-neighborhood"
        >
          <option value="">{neighborhoodPlaceholder(district, neighborhoods)}</option>
          {neighborhoodOptions.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <span className="help-text" id={`${neighborhoodId}-help`} data-testid="request-neighborhood-help">
          {neighborhoodHelp({
            status: neighborhoods.status,
            neighborhoodRequired,
            districtHasNoNeighborhoods,
            helpText: neighborhoodHelpText,
          })}
        </span>
        {neighborhoods.status === 'unavailable' ? (
          <button
            type="button"
            className="location-retry"
            onClick={() => setAttempt((value) => value + 1)}
            data-testid="request-neighborhood-retry"
          >
            Tekrar dene
          </button>
        ) : null}
        {required && neighborhoods.status === 'ready' ? (
          <details className="location-missing" data-testid="request-neighborhood-missing">
            <summary>Mahallem listede yok</summary>
            <p>
              Liste, PTT&apos;nin posta kodu listesinden gelir. Mahallenizi bulamıyorsanız
              yakın bir mahalle seçmeyin: talebiniz yanlış bölgedeki hizmet verenlere gider.{' '}
              <a href="/destek/yeni" target="_blank" rel="noopener">
                Destek ekibimize yazın
              </a>
              , mahallenizi kontrol edip size dönelim.
            </p>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function neighborhoodHelp(input: {
  status: NeighborhoodState['status'];
  neighborhoodRequired: boolean;
  districtHasNoNeighborhoods: boolean;
  helpText?: string | null;
}): string {
  if (input.status === 'unavailable') {
    return input.neighborhoodRequired
      ? 'Mahalle listesi şu anda getirilemedi. Talebi göndermek için listeyi yeniden yükleyin.'
      : 'Mahalle listesi şu anda getirilemedi. Adres notuna yazabilirsiniz.';
  }
  if (input.districtHasNoNeighborhoods) {
    return input.neighborhoodRequired
      ? 'Bu ilçe için kayıtlı mahalle yok; talebiniz ilçe genelinde yayınlanır. Ayrıntıyı adres notuna yazabilirsiniz.'
      : 'İsteğe bağlı.';
  }
  return (
    input.helpText ??
    (input.neighborhoodRequired
      ? 'Yerinde hizmet için mahalle gereklidir; hizmet verenler bölgelerine göre eşleşir.'
      : 'İsteğe bağlı.')
  );
}

function neighborhoodPlaceholder(district: string, state: NeighborhoodState): string {
  if (!district) return 'Önce ilçe seçiniz';
  if (state.status === 'loading') return 'Yükleniyor...';
  if (state.status === 'unavailable') return 'Liste getirilemedi';
  if (state.status === 'ready' && state.names.length === 0) return 'Kayıtlı mahalle yok';
  return 'Mahalle seçiniz';
}
