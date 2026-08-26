'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { AuthUser } from '../lib/api';
import { IconArrowRight, IconCheck, IconSearch } from './landing-icons';
import { StartChoiceModal } from './start-choice-modal';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

type CategoryHit = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
};

const quickPicks = ['Klima', 'Kombi', 'Elektrikçi', 'Su tesisatı', 'Boya badana', 'Ev temizliği'];

const trustPoints = [
  'Kategoriye özel talep formu',
  'Her talebe kalite skoru',
  'Teklif almak müşteri için ücretsiz',
];

type LandingHeroProps = {
  isCustomer?: boolean;
  isAuthenticated?: boolean;
  user?: AuthUser | null;
};

export function LandingHero({
  isCustomer = false,
  isAuthenticated = false,
  user = null,
}: LandingHeroProps) {
  const primaryCtaLabel = isCustomer ? 'Yeni Talep Oluştur' : 'Teklif Al';
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CategoryHit[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchHits = useCallback(async (term: string) => {
    if (!term.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    try {
      const params = new URLSearchParams({ q: term, limit: '6' });
      const response = await fetch(`${apiUrl}/categories?${params.toString()}`, {
        signal: controller.signal,
        credentials: 'include',
      });
      if (!response.ok) {
        setResults([]);
        return;
      }
      const data = (await response.json()) as CategoryHit[];
      setResults(data);
      setActiveIndex(data.length > 0 ? 0 : -1);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setResults([]);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setActiveIndex(-1);
      return;
    }
    const id = setTimeout(() => {
      void fetchHits(query);
    }, 180);
    return () => clearTimeout(id);
  }, [query, fetchHits]);

  useEffect(() => {
    function onClickOutside(event: MouseEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  function go(hit: CategoryHit) {
    setOpen(false);
    setQuery('');
    router.push(`/categories/${hit.slug}`);
  }

  function submitFreeText(term?: string) {
    const value = (term ?? query).trim();
    if (!value) {
      router.push('/categories');
      return;
    }
    setOpen(false);
    router.push(`/categories?q=${encodeURIComponent(value)}`);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((prev) => (results.length === 0 ? -1 : (prev + 1) % results.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((prev) =>
        results.length === 0 ? -1 : (prev - 1 + results.length) % results.length,
      );
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const hit = results[activeIndex];
      if (hit) {
        go(hit);
      } else {
        submitFreeText();
      }
      return;
    }
    if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  const showDropdown = open && query.trim().length > 0;

  return (
    <section className="lp-hero" id="lp-hero">
      <div className="lp-container lp-hero-grid">
        <div className="lp-hero-left">
          <span className="lp-eyebrow">Yerel hizmet pazaryeri</span>

          <h1 className="lp-h1">İhtiyacını tarif et. Doğru usta sana teklif versin.</h1>
          <p className="lp-hero-sub">
            Talebin kategoriye özel sorularla netleşir, kalite skoruyla puanlanır ve yalnızca
            bölgende çalışan onaylı işletmelere iletilir. Teklif almak ücretsiz.
          </p>

          <div className="lp-hero-search" ref={wrapperRef}>
            <label className="lp-hero-search-label" htmlFor="lp-hero-search-input">
              Hangi hizmete ihtiyacın var?
            </label>
            <div className="lp-hero-search-row">
              <div className="lp-hero-search-input">
                <IconSearch />
                <input
                  id="lp-hero-search-input"
                  type="search"
                  autoComplete="off"
                  placeholder="Örn. klima montajı, elektrikçi, ev temizliği"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setOpen(true);
                  }}
                  onFocus={() => setOpen(true)}
                  onKeyDown={onKeyDown}
                  aria-autocomplete="list"
                  aria-expanded={showDropdown}
                />
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const hit = results[activeIndex >= 0 ? activeIndex : 0];
                  if (hit) go(hit);
                  else submitFreeText();
                }}
              >
                {primaryCtaLabel}
                <IconArrowRight />
              </button>
            </div>
            <div className="lp-hero-quick">
              <span className="lp-hero-quick-label">Popüler:</span>
              {quickPicks.map((q) => (
                <button
                  type="button"
                  key={q}
                  className="tag-outline"
                  onClick={() => {
                    setQuery(q);
                    setOpen(true);
                  }}
                >
                  {q}
                </button>
              ))}
            </div>

            {showDropdown ? (
              <div className="lp-hero-search-dropdown" role="listbox">
                {loading ? (
                  <div className="lp-hero-search-status">Aranıyor…</div>
                ) : results.length > 0 ? (
                  <>
                    <ul className="lp-hero-search-list">
                      {results.map((hit, index) => (
                        <li key={hit.id}>
                          <button
                            type="button"
                            className={`lp-hero-search-item${index === activeIndex ? ' is-active' : ''}`}
                            role="option"
                            aria-selected={index === activeIndex}
                            onMouseEnter={() => setActiveIndex(index)}
                            onClick={() => go(hit)}
                          >
                            <span className="lp-hero-search-item-name">{hit.name}</span>
                            {hit.description ? (
                              <span className="lp-hero-search-item-desc">{hit.description}</span>
                            ) : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      className="lp-hero-search-all"
                      onClick={() => submitFreeText()}
                    >
                      Tüm sonuçları gör
                    </button>
                  </>
                ) : (
                  <div className="lp-hero-search-status">
                    <strong>“{query}”</strong> için eşleşme yok.
                    <button
                      type="button"
                      className="lp-hero-search-all"
                      onClick={() => submitFreeText()}
                    >
                      Yine de tüm kategorilerde ara
                    </button>
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <div className="lp-hero-trust">
            {trustPoints.map((point) => (
              <span className="lp-hero-trust-item" key={point}>
                <span className="lp-hero-trust-mark">
                  <IconCheck size={11} />
                </span>
                <span>{point}</span>
              </span>
            ))}
          </div>

          <div className="lp-hero-cta">
            {isAuthenticated ? (
              <Link className="btn btn-secondary btn-lg" href="/categories">
                {isCustomer ? 'Yeni Talep Oluştur' : 'Hizmet Al'}
              </Link>
            ) : (
              <StartChoiceModal user={user} className="btn btn-secondary btn-lg" />
            )}
            {isCustomer ? (
              <Link className="btn btn-secondary btn-lg" href="/requests/my">
                Taleplerim
              </Link>
            ) : null}
          </div>
        </div>

        <div className="lp-hero-right">
          <div className="lp-hero-mockup-wrap">
            <RequestAnatomyCard />

            <div className="lp-hero-cards">
              <div className="lp-floating-card">
                <span>
                  <span className="lp-floating-label">Ön inceleme</span>
                  <span className="lp-floating-val">Her talep</span>
                </span>
              </div>
              <div className="lp-floating-card">
                <span>
                  <span className="lp-floating-label">Kredi iadesi</span>
                  <span className="lp-floating-val">Otomatik tarama</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * The anatomy of a request, drawn in the shape the customer will actually see.
 *
 * It carries labels only. A score, a budget range or an offer count here would
 * be invented — this page has no request to read them from — so the card shows
 * what a request records rather than pretending to be one.
 */
function RequestAnatomyCard() {
  return (
    <div className="lp-request-card" aria-hidden="true">
      <div className="lp-rc-head">
        <div>
          <div className="lp-rc-title">Talep kartın</div>
          <div className="lp-rc-loc">
            <span>Kategori · konum · oluşturma zamanı</span>
          </div>
        </div>
        <span className="tag tag-accent">Ön inceleme</span>
      </div>

      <div className="lp-rc-quality">
        <div style={{ flex: 1 }}>
          <div className="lp-rc-quality-label">
            Talep kalite skoru
            <small>Detaylı brief · konum · zaman · bütçe · iletişim</small>
          </div>
          <div className="lp-rc-bar">
            <div className="lp-rc-bar-fill" style={{ width: '0%' }} />
          </div>
        </div>
      </div>

      <div className="lp-rc-meta">
        <div className="lp-rc-meta-cell">
          <div className="lp-rc-meta-label">Bütçe</div>
          <div className="lp-rc-meta-value">Senin belirlediğin aralık</div>
        </div>
        <div className="lp-rc-meta-cell">
          <div className="lp-rc-meta-label">Zaman</div>
          <div className="lp-rc-meta-value">Senin seçtiğin aciliyet</div>
        </div>
      </div>

      <div className="lp-rc-offers">
        <div className="lp-rc-offers-head">
          <div className="lp-rc-offers-title">Gelen teklifler</div>
          <div className="lp-rc-offers-count">14 gün boyunca</div>
        </div>
        <div className="lp-rc-offers-list">
          <span className="lp-rc-offers-text">
            Onaylı hizmet verenlerin teklifleri panelinde toplanır.
          </span>
        </div>
      </div>

      <Link className="btn btn-primary btn-block lp-rc-cta" href="/categories">
        Talep oluştur
        <IconArrowRight />
      </Link>
    </div>
  );
}
