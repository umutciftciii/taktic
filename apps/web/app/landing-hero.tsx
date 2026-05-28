'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  IconArrowRight,
  IconCheck,
  IconPhone,
  IconPin,
  IconSearch,
  IconWallet,
} from './landing-icons';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

type CategoryHit = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
};

const quickPicks = ['Klima', 'Kombi', 'Elektrikçi', 'Temizlik', 'Boya Badana'];

export function LandingHero() {
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
      <div className="lp-hero-bg" aria-hidden="true" />
      <div className="lp-container lp-hero-grid">
        <div className="lp-hero-left">
          <span className="lp-hero-eyebrow">
            <span className="lp-tag">Yeni</span>
            <span>Doğrulanmış talep, adil teklif kredisi</span>
          </span>

          <h1 className="lp-h1">
            İhtiyacını anlat, <span className="lp-accent">doğrulanmış</span> hizmet verenlerden teklif al.
          </h1>
          <p className="lp-hero-sub">
            TakTic&apos;te talebini oluştur, uygun hizmet verenlerden teklifleri karşılaştır. Hizmet
            verenler için de adil kredi sistemiyle boşa teklif maliyeti yok.
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
                Teklif Al
                <IconArrowRight />
              </button>
            </div>
            <div className="lp-hero-quick">
              <span className="lp-hero-quick-label">Popüler:</span>
              {quickPicks.map((q) => (
                <button
                  type="button"
                  key={q}
                  className="lp-chip"
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
                      Tüm sonuçları gör →
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
                      Yine de tüm kategorilerde ara →
                    </button>
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <div className="lp-hero-cta">
            <Link className="btn btn-primary btn-lg" href="/categories">
              Hizmet Al
            </Link>
            <Link className="btn btn-secondary btn-lg" href="/providers/register">
              Hizmet Veren Ol
            </Link>
          </div>

          <div className="lp-hero-trust">
            <span className="lp-hero-trust-item">
              <span className="lp-hero-trust-mark">
                <IconCheck size={12} />
              </span>
              <span>Telefon doğrulamalı talepler</span>
            </span>
            <span className="lp-hero-trust-item">
              <span className="lp-hero-trust-mark">
                <IconCheck size={12} />
              </span>
              <span>Talep kalite skoru</span>
            </span>
            <span className="lp-hero-trust-item">
              <span className="lp-hero-trust-mark">
                <IconCheck size={12} />
              </span>
              <span>Şeffaf teklif süreci</span>
            </span>
          </div>
        </div>

        <div className="lp-hero-right">
          <div className="lp-hero-mockup-wrap">
            <div className="lp-mockup-bg-blob" aria-hidden="true" />
            <RequestCard />

            <div className="lp-floating-card lp-fc-top">
              <span className="lp-floating-ic lp-floating-ic-success">
                <IconCheck size={14} />
              </span>
              <span>
                <span className="lp-floating-label">Telefon</span>
                <span className="lp-floating-val">Doğrulandı</span>
              </span>
            </div>

            <div className="lp-floating-card lp-fc-bottom">
              <span className="lp-floating-ic lp-floating-ic-primary">
                <IconWallet size={14} />
              </span>
              <span>
                <span className="lp-floating-label">Kredi iadesi</span>
                <span className="lp-floating-val">+3 kredi</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function RequestCard() {
  return (
    <div className="lp-request-card">
      <div className="lp-rc-head">
        <div>
          <div className="lp-rc-title">Klima Montajı Talebi</div>
          <div className="lp-rc-loc">
            <IconPin size={12} />
            <span>Kadıköy / İstanbul · 2 saat önce</span>
          </div>
        </div>
        <span className="lp-badge lp-badge-success">
          <IconPhone size={11} />
          Doğrulandı
        </span>
      </div>

      <div className="lp-rc-quality">
        <div className="lp-rc-quality-score">
          86<sup>/100</sup>
        </div>
        <div style={{ flex: 1 }}>
          <div className="lp-rc-quality-label">
            Talep Kalite Skoru
            <small>Detaylı brief · konum · zaman · bütçe</small>
          </div>
          <div className="lp-rc-bar">
            <div className="lp-rc-bar-fill" />
          </div>
        </div>
      </div>

      <div className="lp-rc-meta">
        <div className="lp-rc-meta-cell">
          <div className="lp-rc-meta-label">Bütçe</div>
          <div className="lp-rc-meta-value">3.000 – 5.000 ₺</div>
        </div>
        <div className="lp-rc-meta-cell">
          <div className="lp-rc-meta-label">Zaman</div>
          <div className="lp-rc-meta-value">Bu hafta</div>
        </div>
      </div>

      <div className="lp-rc-offers">
        <div className="lp-rc-offers-head">
          <div className="lp-rc-offers-title">Gelen teklifler</div>
          <div className="lp-rc-offers-count">son 24 saatte</div>
        </div>
        <div className="lp-rc-offers-list">
          <div className="lp-rc-avatars">
            <span className="lp-avatar">MK</span>
            <span className="lp-avatar lp-avatar-2">EY</span>
            <span className="lp-avatar lp-avatar-3">SD</span>
            <span className="lp-avatar lp-avatar-4">+1</span>
          </div>
          <span className="lp-rc-offers-text">4 doğrulanmış hizmet veren</span>
        </div>
      </div>

      <Link className="btn btn-primary lp-rc-cta" href="/categories">
        Teklifleri İncele
        <IconArrowRight />
      </Link>
    </div>
  );
}
