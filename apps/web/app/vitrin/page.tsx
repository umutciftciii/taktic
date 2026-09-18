import type { Metadata } from 'next';
import { cache } from 'react';
import Link from 'next/link';
import { apiFetch, type ShowcaseFeed } from '../../lib/api';
import { SEO_DEFAULT_IMAGE, publicPageMetadata } from '../../lib/seo-metadata';
import type { ProvinceWithDistricts } from '../../lib/locations';
import { ShowcaseShelfCard } from '../showcase-shelf';

type ShowcaseDirectoryProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * The vitrin discovery surface: every live card, narrowable by province.
 *
 * ## Why this is a separate screen from the home page shelf
 *
 * The home page shelf used to *be* this: it asked for a province and rendered
 * nothing until it had one. That made the paid surface invisible to everybody
 * who arrived without a query string, which is nearly everybody.
 *
 * So the two jobs were split. The home page publishes what businesses paid to
 * publish, unconditionally, with each card stating its own service area.
 * Narrowing by place is a genuinely useful thing to want, and it happens here —
 * where choosing a province is the point of the screen rather than a toll gate
 * in front of one. **Nothing on the home page depends on this page existing.**
 *
 * The location lives in the URL rather than in a cookie or in component state,
 * which is what makes the whole screen a server component: no client bundle,
 * and a list somebody can bookmark or send to a friend.
 */
/** The sentence under the heading — also the page's description for a search result. */
const SHELF_INTRO =
  'Kartlar hizmet bölgeleriyle birlikte listelenir. İsterseniz bölgeye göre daraltın; daraltmasanız da yayındaki tüm hizmetleri görürsünüz.';

/**
 * Indexable on the clean path only, and only while the API says the shelf is
 * index-eligible (`seoIndexable` on the feed, SEO-003: enough indexable live
 * cards to be a list). `?il=` and `?ilce=` are the same shelf narrowed — a
 * filter result, not a page of its own — and are noindex. The feed is read
 * once per request (`loadFeed` is cached) so the metadata and the page see
 * the same answer.
 */
export async function generateMetadata({ searchParams }: ShowcaseDirectoryProps): Promise<Metadata> {
  const params = (await searchParams) ?? {};
  const feed = await loadFeed(readParam(params.il), readParam(params.ilce));
  return publicPageMetadata({
    route: '/vitrin',
    params: {},
    title: 'Vitrin hizmetleri',
    description: SHELF_INTRO,
    image: SEO_DEFAULT_IMAGE,
    searchParams: params,
    indexEligible: feed?.seoIndexable === true,
  });
}

export default async function ShowcaseDirectoryPage({ searchParams }: ShowcaseDirectoryProps) {
  const params = (await searchParams) ?? {};
  const city = readParam(params.il);
  const district = readParam(params.ilce);

  const [feed, provinces] = await Promise.all([loadFeed(city, district), loadProvinces()]);
  const selectedProvince = provinces.find((province) => province.name === city) ?? null;

  return (
    <main className="lp-section">
      <div className="lp-container">
        <nav className="pdash-crumbs" aria-label="Breadcrumb">
          <Link href="/">Ana sayfa</Link>
          <span aria-hidden="true">/</span>
          <span>Vitrin</span>
        </nav>

        <header className="lp-section-head">
          <span className="kicker">Vitrin</span>
          <h1 className="lp-section-title">Vitrin hizmetleri</h1>
          <p className="lp-section-sub">{SHELF_INTRO}</p>
        </header>

        {/*
          A plain GET form, so choosing a place is a navigation. No JavaScript,
          the result is linkable, and the page stays a server component.
        */}
        <form className="showcase-shelf-picker" method="get" action="/vitrin">
          <label>
            <span>İl</span>
            <select name="il" defaultValue={city ?? ''}>
              <option value="">Tüm iller</option>
              {provinces.map((province) => (
                <option key={province.code} value={province.name}>
                  {province.name}
                </option>
              ))}
            </select>
          </label>

          {/*
            The district list is only offered once a province is chosen, because
            there is nothing to list before that.
          */}
          {selectedProvince ? (
            <label>
              <span>İlçe</span>
              <select name="ilce" defaultValue={district ?? ''}>
                <option value="">Tüm ilçeler</option>
                {selectedProvince.districts.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <button className="btn btn-primary" type="submit">
            Göster
          </button>
        </form>

        {!feed ? (
          <p className="muted" data-testid="showcase-directory-empty">
            Vitrin listesi şu anda yüklenemedi.
          </p>
        ) : feed.cards.length === 0 ? (
          <p className="muted" data-testid="showcase-directory-empty">
            {feed.location
              ? `${feed.location.label} için şu anda vitrinde hizmet yok.`
              : 'Şu anda vitrinde yayında olan bir hizmet yok.'}
          </p>
        ) : (
          <div className="vitrin-grid" data-testid="showcase-directory">
            {feed.cards.map((card) => (
              <ShowcaseShelfCard card={card} key={card.cardId} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

/**
 * A list that cannot be loaded is an empty list, not a broken page.
 *
 * A province the API refuses — one that is not in the shipped list — is a bad
 * query string rather than an error worth an error screen.
 */
const loadFeed = cache(async (city: string | null, district: string | null): Promise<ShowcaseFeed | null> => {
  const params = new URLSearchParams();
  if (city) params.set('city', city);
  if (city && district) params.set('district', district);
  const query = params.toString();

  try {
    return await apiFetch<ShowcaseFeed>(`/showcase/feed${query ? `?${query}` : ''}`);
  } catch {
    return null;
  }
});

async function loadProvinces(): Promise<ProvinceWithDistricts[]> {
  try {
    return await apiFetch<ProvinceWithDistricts[]>('/locations/provinces');
  } catch {
    return [];
  }
}

function readParam(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}
