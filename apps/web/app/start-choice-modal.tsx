'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AuthUser } from '../lib/api';

type Choice = 'BUY' | 'SELL';

type StartChoiceModalProps = {
  user: AuthUser | null;
  label?: string;
  className?: string;
};

const DEFAULT_LABEL = 'Hadi Başla';

function resolveSellRoute(user: AuthUser | null): string {
  if (!user) return '/register/provider';
  switch (user.role) {
    case 'PROVIDER':
      return '/providers/me';
    case 'SUPER_ADMIN':
      return '/providers/me';
    case 'CUSTOMER':
    default:
      return '/register/provider';
  }
}

export function StartChoiceModal({ user, label = DEFAULT_LABEL, className }: StartChoiceModalProps) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Choice | null>(null);
  const router = useRouter();
  const titleId = useId();
  const subtitleId = useId();

  const close = useCallback(() => {
    setOpen(false);
    setChoice(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, close]);

  function handleContinue() {
    if (!choice) return;
    const target = choice === 'BUY' ? '/categories' : resolveSellRoute(user);
    setOpen(false);
    router.push(target);
  }

  const triggerClass = className ?? 'btn btn-primary btn-lg';

  return (
    <>
      <button type="button" className={triggerClass} onClick={() => setOpen(true)}>
        {label}
      </button>

      {open ? (
        <div
          className="start-choice-overlay"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <div
            className="start-choice-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={subtitleId}
          >
            <button
              type="button"
              className="start-choice-close"
              onClick={close}
              aria-label="Kapat"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M6 6l12 12M18 6L6 18"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>

            <div className="start-choice-head">
              <img className="start-choice-brand-logo" src="/brand/logo.png" alt="TakTick" />
              <h2 className="start-choice-title" id={titleId}>
                Neye ihtiyacın var?
              </h2>
              <p className="start-choice-subtitle" id={subtitleId}>
                Platformu nasıl kullanmak istediğini seçerek sana en uygun deneyimi sunmamıza yardımcı ol.
              </p>
            </div>

            <div className="start-choice-cards">
              <ChoiceCard
                active={choice === 'BUY'}
                onSelect={() => setChoice('BUY')}
                title="Hizmet almak istiyorum."
                description="İhtiyacını anlat, doğrulanmış hizmet verenlerden teklif al."
                visualSrc="/brand/start-choice-customer.png"
                visualAlt="Hizmet almak"
              />
              <ChoiceCard
                active={choice === 'SELL'}
                onSelect={() => setChoice('SELL')}
                title="Hizmet vermek istiyorum."
                description="Profilini oluştur, uygun taleplere teklif ver."
                visualSrc="/brand/start-choice-provider.png"
                visualAlt="Hizmet vermek"
              />
            </div>

            <div className="start-choice-footer">
              <button
                type="button"
                className="start-choice-continue"
                onClick={handleContinue}
                disabled={!choice}
              >
                Devam Et
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

type ChoiceCardProps = {
  active: boolean;
  onSelect: () => void;
  title: string;
  description: string;
  visualSrc: string;
  visualAlt: string;
};

function ChoiceCard({ active, onSelect, title, description, visualSrc, visualAlt }: ChoiceCardProps) {
  return (
    <button
      type="button"
      className={`start-choice-card${active ? ' is-active' : ''}`}
      onClick={onSelect}
      aria-pressed={active}
    >
      <img className="start-choice-card-visual" src={visualSrc} alt={visualAlt} />
      <span className="start-choice-card-title">{title}</span>
      <span className="start-choice-card-desc">{description}</span>
    </button>
  );
}
