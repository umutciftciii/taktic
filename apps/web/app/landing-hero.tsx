'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { AuthUser } from '../lib/api';
import {
  heroDemoNextIndex,
  heroDemoOffers,
  heroDemoShouldRun,
  heroDemoSnapshot,
  heroDemoStages,
  heroDemoStaticSnapshot,
  type HeroDemoSnapshot,
} from '../lib/hero-demo';
import { heroHeadlineLines } from '../lib/hero-headline';
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
  /** The platform's current refund window, so the card never states its own. */
  refundWindowHours: number;
};

export function LandingHero({
  isCustomer = false,
  isAuthenticated = false,
  user = null,
  refundWindowHours,
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

          <h1 className="lp-h1">
            {heroHeadlineLines.map((line) => (
              <span className="lp-h1-line" key={line.map((segment) => segment.text).join('')}>
                {line.map((segment) =>
                  segment.accent ? (
                    <span className="lp-accent" key={segment.text}>
                      {segment.text}
                    </span>
                  ) : (
                    segment.text
                  ),
                )}
              </span>
            ))}
          </h1>
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
            <RequestProcessDemo />

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
                  <span className="lp-floating-val">{refundWindowHours} saat kuralı</span>
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
 * The anatomy of a request, walked through the process rather than posed in it.
 *
 * The card used to be a still life: it named the parts of a request — quality
 * score, budget, timing, offers — and left the visitor to imagine the rest. The
 * part it could not put in a sentence is that a request is created once and
 * then keeps moving: it is checked, it reaches the businesses that work in the
 * visitor's area, offers come back, and the job gets done. So the card now
 * walks that process, in the product's own status labels, on a loop of about
 * nine seconds.
 *
 * It is a card, not a video. Nothing here moves except what has to: the step
 * marks along the rail, the status tag, the quality bar and the offer rows
 * fading in. Everything is in the DOM from the first paint at the size it will
 * keep, so no state change ever moves anything else on the page.
 *
 * It still carries labels rather than figures. A price, a rating or a business
 * name would be invented — this page has no request to read them from — so
 * `lib/hero-demo.ts` holds what an offer carries, and the numbers wait for the
 * visitor's own request.
 *
 * The card is `aria-hidden`, as it always was. A loop that announced itself
 * three times every nine seconds would be the worst thing on the page for a
 * screen reader, and the column beside it already says all of this in prose.
 */
function RequestProcessDemo() {
  const cardRef = useRef<HTMLDivElement>(null);
  const { snapshot, reducedMotion } = useHeroDemoLoop(cardRef);

  return (
    <div
      className="lp-request-card lp-rc-demo"
      ref={cardRef}
      data-testid="hero-demo"
      data-stage={snapshot.stage.id}
      data-motion={reducedMotion ? 'static' : 'live'}
      aria-hidden="true"
    >
      <div className="lp-rc-head">
        <div>
          <div className="lp-rc-title">Talep kartın</div>
          <div className="lp-rc-loc">
            <span>Kategori · konum · oluşturma zamanı</span>
          </div>
        </div>
        <span className="tag tag-accent" data-testid="hero-demo-status">
          {snapshot.stage.status}
        </span>
      </div>

      <div className="lp-rc-quality">
        <div style={{ flex: 1 }}>
          <div className="lp-rc-quality-label">
            Talep kalite skoru
            <small>Detaylı brief · konum · zaman · bütçe · iletişim</small>
          </div>
          <div className="lp-rc-bar">
            <div
              className="lp-rc-bar-fill"
              data-testid="hero-demo-progress"
              style={{ width: `${snapshot.progress}%` }}
            />
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

      <ol className="lp-rc-steps">
        {snapshot.steps.map((step) => (
          <li
            className="lp-rc-step"
            key={step.id}
            data-testid="hero-demo-step"
            data-step={step.id}
            data-state={step.state}
            data-current={step.current ? 'true' : 'false'}
          >
            <span className="lp-rc-step-mark">
              <IconCheck size={10} />
            </span>
            <span className="lp-rc-step-label">{step.label}</span>
          </li>
        ))}
      </ol>

      {/*
       * One line for whichever step is being held. It sits in a box tall enough
       * for the longest of the three so that swapping the text never shifts the
       * offers or the button underneath it.
       */}
      <p className="lp-rc-step-detail" data-testid="hero-demo-detail">
        {snapshot.stage.detail}
      </p>

      <div className="lp-rc-offers">
        <div className="lp-rc-offers-head">
          <div className="lp-rc-offers-title">Gelen teklifler</div>
          <div className="lp-rc-offers-count">14 gün boyunca</div>
        </div>
        <ul className="lp-rc-offer-rows">
          {heroDemoOffers.map((offer, position) => (
            <li
              className="lp-rc-offer"
              key={offer.id}
              data-testid="hero-demo-offer"
              data-visible={position < snapshot.offersVisible ? 'true' : 'false'}
              style={{ '--lp-rc-offer-delay': `${position * 240}ms` } as React.CSSProperties}
            >
              <span className="lp-rc-offer-mark" />
              <span className="lp-rc-offer-title">{offer.title}</span>
              <span className="lp-rc-offer-detail">{offer.detail}</span>
            </li>
          ))}
        </ul>
      </div>

      <Link className="btn btn-primary btn-block lp-rc-cta" href="/categories" tabIndex={-1}>
        Talep oluştur
        <IconArrowRight />
      </Link>
    </div>
  );
}

/**
 * Which step of the demo is being held, and whether it is moving at all.
 *
 * Three separate conditions each stop the loop, and each is reported by a
 * different browser API: the visitor's motion preference, whether this tab is
 * the one being looked at, and whether the hero is on screen. Every one of them
 * is watched here and none of them is interpreted — `heroDemoShouldRun` makes
 * the decision, so the rule is stated once and tested without a browser.
 *
 * Stopping leaves the current step exactly where it was. Coming back — the tab
 * refocused, the hero scrolled into view — starts that step's hold over from
 * the beginning rather than firing whatever was left on a stale timer, so a
 * page returned to after an hour resumes at a readable pace instead of jumping.
 *
 * On the server, and on the first client render, the card is the first step:
 * a request just created, nothing else claimed yet. That is what makes the
 * opening calm, and it is also the only frame a visitor who has refused motion
 * would ever see moving — so for them the effect below swaps in the finished
 * process instead, which is the version that means something standing still.
 */
function useHeroDemoLoop(cardRef: React.RefObject<HTMLElement | null>): {
  snapshot: HeroDemoSnapshot;
  reducedMotion: boolean;
} {
  const [index, setIndex] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [inViewport, setInViewport] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReducedMotion(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    const sync = () => setPageVisible(document.visibilityState === 'visible');
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    if (typeof IntersectionObserver === 'undefined') {
      // No observer to ask, so the card is treated as visible rather than
      // frozen: a browser without one still gets the demonstration.
      setInViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => setInViewport(entries.some((entry) => entry.isIntersecting)),
      { threshold: 0.25 },
    );
    observer.observe(card);
    return () => observer.disconnect();
  }, [cardRef]);

  const running = heroDemoShouldRun({ reducedMotion, pageVisible, inViewport });

  useEffect(() => {
    if (!running) return;
    const hold = heroDemoStages[heroDemoSnapshot(index).index]!.holdMs;
    const timer = setTimeout(() => setIndex((current) => heroDemoNextIndex(current)), hold);
    return () => clearTimeout(timer);
  }, [running, index]);

  return {
    snapshot: reducedMotion ? heroDemoStaticSnapshot : heroDemoSnapshot(index),
    reducedMotion,
  };
}
