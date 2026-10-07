'use client';

import Link from 'next/link';
import { useActionState, useId, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import { SEO_REDIRECT_TYPE_LABELS, type SeoRedirectType } from '../../../lib/seo';
import { approveSuggestionAction, createRedirectAction, updateRedirectAction } from '../actions';
import { SEO_FORM_IDLE, type SeoFormState } from '../seo-form-state';

/**
 * The redirect windows (SEO-004 PR B), design paket 4
 * `43-yonlendirme-ekle-penceresi`: a new redirect, an edit, and a 404
 * suggestion's approval — one form, three modes, the same fields and the same
 * refusal handling.
 *
 * - **Kaynak** (eski adres) is typed only when creating. After that it is the
 *   redirect's identity and is shown read-only: the API has no field to change
 *   it, and a suggestion's source is the path that answered 404.
 * - **Hedef** is a site-internal path, offered from the live canonical pages
 *   the panel can list (a datalist) and checked by the API: it must name one of
 *   the public page shapes and be live now. A full URL is refused, never
 *   followed — there is no way to point a redirect off the site.
 * - **Tür**: 301 Kalıcı / 302 Geçici. A redirect a slug change wrote stays 301
 *   (the API refuses a change), so its form shows the type and sends none.
 *
 * Every rule — same source and target, a live source, a dead target, a held
 * source, a chain or a cycle — is the API's; its refusal comes back under the
 * form with everything typed kept.
 */

type Mode =
  | { kind: 'create' }
  | { kind: 'edit'; redirectId: string; sourcePath: string; lockedType: boolean }
  | { kind: 'approve'; suggestionId: string; sourcePath: string };

type RedirectFormProps = {
  mode: Mode;
  defaultTarget?: string;
  defaultType?: SeoRedirectType;
  defaultReason?: string;
  /** Live canonical paths for the target's suggestions; the API still decides. */
  targets: string[];
  cancelHref: string;
};

const TYPE_HINTS: Record<SeoRedirectType, string> = {
  PERMANENT: 'Adres temelli değişti. Arama sıralaması yeni adrese taşınır.',
  TEMPORARY: 'Eski adres geri dönecek. Sıralama taşınmaz; kampanyalar için.',
};

function actionFor(mode: Mode): (state: SeoFormState, formData: FormData) => Promise<SeoFormState> {
  if (mode.kind === 'edit') return updateRedirectAction;
  if (mode.kind === 'approve') return approveSuggestionAction;
  return createRedirectAction;
}

export function RedirectForm({
  mode,
  defaultTarget = '',
  defaultType = 'PERMANENT',
  defaultReason = '',
  targets,
  cancelHref,
}: RedirectFormProps) {
  const [state, formAction] = useActionState(actionFor(mode), SEO_FORM_IDLE);
  const [type, setType] = useState<SeoRedirectType>(defaultType);
  // Controlled, every one: React resets an uncontrolled form once its action
  // settles, and a refusal must leave what was typed where it was.
  const [source, setSource] = useState('');
  const [target, setTarget] = useState(defaultTarget);
  const [reason, setReason] = useState(defaultReason);
  const listId = `${useId()}-targets`;
  const error = state.kind === 'error' ? state : null;
  const errorOn = (field: string) => (error?.field === field ? error.message : null);
  const lockedType = mode.kind === 'edit' && mode.lockedType;

  return (
    <form action={formAction} className="seo-modal-form" data-testid="seo-redirect-form">
      {mode.kind === 'edit' ? <input type="hidden" name="redirectId" value={mode.redirectId} /> : null}
      {mode.kind === 'approve' ? <input type="hidden" name="suggestionId" value={mode.suggestionId} /> : null}

      <div className="seo-field-pair">
        {mode.kind === 'create' ? (
          <label className="seo-field">
            <span className="seo-field-label">Eski adres</span>
            <span className="seo-prefix-input">
              <span className="seo-prefix" aria-hidden="true">
                site içi yol
              </span>
              <input
                name="sourcePath"
                required
                autoComplete="off"
                spellCheck={false}
                maxLength={400}
                value={source}
                onChange={(event) => setSource(event.target.value)}
                placeholder="/eski-sayfa"
                aria-invalid={errorOn('sourcePath') ? true : undefined}
                data-testid="seo-redirect-source"
              />
            </span>
          </label>
        ) : (
          <div className="seo-field">
            <span className="seo-field-label">Eski adres</span>
            <div className="locked-field" data-testid="seo-redirect-source-locked">
              <code className="locked-field-value">{mode.sourcePath}</code>
              <span className="locked-field-tag">Değiştirilemez</span>
            </div>
          </div>
        )}

        <label className="seo-field">
          <span className="seo-field-label">Gideceği adres</span>
          <span className="seo-prefix-input">
            <span className="seo-prefix" aria-hidden="true">
              site içi yol
            </span>
            <input
              name="targetPath"
              required={mode.kind !== 'approve'}
              autoComplete="off"
              spellCheck={false}
              maxLength={400}
              list={listId}
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder="/categories/kombi-servisi"
              aria-invalid={errorOn('targetPath') ? true : undefined}
              data-testid="seo-redirect-target"
            />
          </span>
          <datalist id={listId}>
            {targets.map((path) => (
              <option key={path} value={path} />
            ))}
          </datalist>
          <span className="help-text">
            Yalnız sitenin yayındaki bir sayfası: ana sayfa, /categories, /categories/…, /isletme/…, /vitrin veya /vitrin/….
          </span>
        </label>
      </div>

      <fieldset className="seo-field seo-type-choice" data-testid="seo-redirect-type">
        <legend className="seo-field-label">Yönlendirme türü</legend>
        {lockedType ? (
          <div className="locked-field">
            <span className="locked-field-value">301 · Kalıcı — adres değişikliğinden doğdu, kalıcı kalır</span>
            <span className="locked-field-tag">Değiştirilemez</span>
          </div>
        ) : (
          <div className="seo-type-options">
            {(['PERMANENT', 'TEMPORARY'] as const).map((value) => (
              <label key={value} className={type === value ? 'seo-type-option is-selected' : 'seo-type-option'}>
                <input
                  type="radio"
                  name="type"
                  value={value}
                  checked={type === value}
                  onChange={() => setType(value)}
                  data-testid={`seo-redirect-type-${value === 'PERMANENT' ? '301' : '302'}`}
                />
                <span>
                  <strong>
                    {SEO_REDIRECT_TYPE_LABELS[value].label} ({SEO_REDIRECT_TYPE_LABELS[value].code})
                  </strong>
                  <span className="cell-muted">{TYPE_HINTS[value]}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <label className="seo-field">
        <span className="seo-field-label">
          Sebep <span className="cell-muted">— kayıtta görünür</span>
        </span>
        <input
          name="reason"
          required={mode.kind === 'create'}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Örn. eski site yapısından gelen bağlantılar"
          data-testid="seo-redirect-reason"
        />
      </label>

      <div className="seo-check-note">
        Kaydetmeden önce kontrol edilir: aynı eski adres için başka etkin yönlendirme var mı, eski adres yayında bir sayfa
        mı, gideceği adres yayında mı, zincir (A→B→C) veya kendine dönen bir döngü oluşuyor mu. Bu durumlarda kayıt kabul
        edilmez.
      </div>

      {error ? (
        <div className="notice notice-error" role="alert" data-testid="seo-redirect-error" data-code={error.code ?? undefined}>
          {error.message}
        </div>
      ) : null}

      <div className="form-actions">
        {mode.kind === 'approve' ? (
          <ConfirmDialog
            proof="seo.suggestion-approve"
            triggerLabel="Onayla ve yönlendir"
            triggerClassName="btn btn-primary"
            title="404 önerisini onayla"
            consequence={
              <div data-testid="seo-suggestion-approve-body">
                <dl className="confirm-dialog-facts">
                  <div>
                    <dt>Eski adres</dt>
                    <dd>
                      <code>{mode.sourcePath}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Gideceği adres</dt>
                    <dd>
                      <strong>
                        <code>{target || '—'}</code>
                      </strong>
                    </dd>
                  </div>
                  <div>
                    <dt>Tür</dt>
                    <dd>{SEO_REDIRECT_TYPE_LABELS[type].badge}</dd>
                  </div>
                </dl>
                <p>Onaylandığında yönlendirme hemen etkin olur ve öneri listeden çıkar.</p>
              </div>
            }
            confirmLabel="Evet, yönlendirmeyi oluştur"
            tone="primary"
            testId="seo-suggestion-approve-submit"
          />
        ) : (
          <SubmitButton label={mode.kind === 'edit' ? 'Değişiklikleri kaydet' : 'Yönlendirmeyi ekle'} />
        )}
        <Link className="btn btn-secondary" href={cancelHref} scroll={false}>
          Vazgeç
        </Link>
      </div>
    </form>
  );
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button className="btn btn-primary" type="submit" disabled={pending} data-testid="seo-redirect-submit">
      {pending ? 'Kaydediliyor…' : label}
    </button>
  );
}
