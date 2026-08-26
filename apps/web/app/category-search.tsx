'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { IconSearch } from './landing-icons';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

type CategoryHit = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
};

type CategorySearchProps = {
  variant?: 'compact' | 'hero';
  placeholder?: string;
  autoFocus?: boolean;
};

export function CategorySearch({
  variant = 'compact',
  placeholder = 'Hizmet ara (ör. klima, tadilat, temizlik)',
  autoFocus = false,
}: CategorySearchProps) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CategoryHit[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
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
      const params = new URLSearchParams({ q: term, limit: '8' });
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

  function submitFreeText() {
    const term = query.trim();
    if (!term) return;
    setOpen(false);
    router.push(`/categories?q=${encodeURIComponent(term)}`);
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
      setActiveIndex((prev) => (results.length === 0 ? -1 : (prev - 1 + results.length) % results.length));
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
      inputRef.current?.blur();
    }
  }

  const showDropdown = open && (loading || results.length > 0 || (query.trim().length > 0 && !loading));

  return (
    <div ref={wrapperRef} className={`category-search category-search-${variant}`}>
      <div className="category-search-input-wrap">
        <span className="category-search-icon">
          <IconSearch size={18} />
        </span>
        <input
          ref={inputRef}
          className="category-search-input"
          type="search"
          autoComplete="off"
          placeholder={placeholder}
          value={query}
          autoFocus={autoFocus}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          aria-label="Hizmet kategorisi ara"
          aria-autocomplete="list"
          aria-expanded={showDropdown}
        />
        {variant === 'hero' ? (
          <button
            type="button"
            className="btn btn-primary category-search-submit"
            onClick={() => {
              const hit = results[activeIndex >= 0 ? activeIndex : 0];
              if (hit) {
                go(hit);
              } else {
                submitFreeText();
              }
            }}
          >
            Ara
          </button>
        ) : null}
      </div>

      {showDropdown ? (
        <div className="category-search-dropdown" role="listbox">
          {loading ? (
            <div className="category-search-status">Aranıyor…</div>
          ) : results.length > 0 ? (
            <>
              <ul className="category-search-list">
                {results.map((hit, index) => (
                  <li key={hit.id}>
                    <button
                      type="button"
                      className={`category-search-item${index === activeIndex ? ' is-active' : ''}`}
                      role="option"
                      aria-selected={index === activeIndex}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => go(hit)}
                    >
                      <span className="category-search-item-name">{hit.name}</span>
                      {hit.description ? (
                        <span className="category-search-item-desc">{hit.description}</span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="category-search-all" onClick={submitFreeText}>
                Tüm sonuçları gör
              </button>
            </>
          ) : (
            <div className="category-search-status category-search-empty">
              <strong>“{query}”</strong> ile eşleşen kategori bulunamadı.
              <button type="button" className="category-search-all" onClick={submitFreeText}>
                Yine de tüm kategorilerde ara
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
