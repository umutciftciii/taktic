'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import {
  CATEGORY_SLUG_MAX_LENGTH,
  previewCategorySlug,
  seoRefusalMessage,
  slugRefusalMessage,
  type SeoSlugPreview,
} from '../../../lib/seo';
import { changeCategorySlugAction, previewSlugChangeAction } from '../actions';
import { SEO_FORM_IDLE } from '../seo-form-state';

type SlugChangeFormProps = {
  categoryId: string;
  categoryName: string;
  currentSlug: string;
  /** Whether the category is reachable by the public now: decides the 301. */
  publiclyReachable: boolean;
  /** Where Vazgeç goes. */
  cancelHref: string;
  /** `category`: a success returns to the category's own screen, at its new address. */
  returnTo: 'category' | 'list';
};

/** The PR A product rule, said where the operator decides (SEO-004, locked). */
export const PUBLIC_SLUG_REDIRECT_COPY = 'Eski adres otomatik olarak yeni adrese kalıcı (301) yönlendirilir.';
export const NON_PUBLIC_SLUG_REDIRECT_COPY =
  'Bu kategori herkese açık olmadığı için yönlendirme oluşturulmaz; yalnız adres değişir.';

/**
 * "Adresi değiştir" (SEO-004 PR B), design paket 4 `41-slug-degistir-penceresi`.
 *
 * The operator types a name-like text; the line under the field shows the
 * address it becomes while typing — the API's derivation, restated in
 * `lib/seo.ts` as a preview only — and the API's own preview
 * (`slug-preview`) says, a moment later, whether the address is taken, held by
 * a redirect, or reserved, and what saving will do to the redirect graph.
 *
 * The design's "otomatik yönlendirme oluştur" checkbox is gone on purpose: for
 * a public category the 301 is mandatory and written in the same transaction
 * as the slug, so there is nothing to opt out of. The window says so instead.
 *
 * Saving asks first (`seo.slug-change`). The API decides everything again on
 * save; a refusal comes back under the field with the text kept.
 */
export function SlugChangeForm({
  categoryId,
  categoryName,
  currentSlug,
  publiclyReachable,
  cancelHref,
  returnTo,
}: SlugChangeFormProps) {
  const [state, formAction] = useActionState(changeCategorySlugAction, SEO_FORM_IDLE);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<SeoSlugPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const requestRef = useRef(0);

  const local = text.trim() === '' ? null : previewCategorySlug(text);
  const localSlug = local?.ok ? local.slug : null;

  // The server's preview, for the slug the local rule derives — at most one
  // request in flight that matters: an answer for an older text is dropped.
  useEffect(() => {
    if (!localSlug || localSlug === currentSlug) {
      setPreview(null);
      setChecking(false);
      return;
    }
    const request = ++requestRef.current;
    setChecking(true);
    const timer = window.setTimeout(async () => {
      const answer = await previewSlugChangeAction(categoryId, text);
      if (request !== requestRef.current) return;
      setPreview(answer);
      setChecking(false);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [categoryId, currentSlug, localSlug, text]);

  const unchanged = localSlug !== null && localSlug === currentSlug;
  const serverAgrees = preview !== null && preview.slug === localSlug;
  const problem: string | null =
    local && !local.ok
      ? slugRefusalMessage(local.refusal)
      : unchanged
        ? 'Yeni adres şu anki adresle aynı.'
        : serverAgrees && preview.refusal
          ? slugRefusalMessage(preview.refusal)
          : serverAgrees && preview.conflict
            ? seoRefusalMessage({ code: preview.conflict })
            : null;
  const ready = Boolean(localSlug) && !unchanged && !problem && !checking;
  const createsRedirect = serverAgrees ? Boolean(preview.createsRedirect) : publiclyReachable;
  const retargetCount = serverAgrees ? (preview.retargetCount ?? 0) : 0;
  const reclaims = serverAgrees && Boolean(preview.reclaimsRedirectId);
  const fieldError = state.kind === 'error' ? state.message : null;

  return (
    <form action={formAction} className="seo-modal-form" data-testid="seo-slug-form">
      <input type="hidden" name="categoryId" value={categoryId} />
      <input type="hidden" name="returnTo" value={returnTo} />

      <div className="seo-field">
        <span className="seo-field-label">Şu anki adres</span>
        <div className="seo-readonly-value" data-testid="seo-slug-current">
          /categories/{currentSlug}
        </div>
      </div>

      <label className="seo-field">
        <span className="seo-field-label">Yeni adres</span>
        <span className="seo-prefix-input">
          <span className="seo-prefix" aria-hidden="true">
            /categories/
          </span>
          <input
            name="slug"
            required
            autoComplete="off"
            spellCheck={false}
            maxLength={200}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={currentSlug}
            aria-invalid={problem || fieldError ? true : undefined}
            aria-describedby="seo-slug-help seo-slug-problem"
            data-testid="seo-slug-input"
          />
        </span>
        <span className="help-text" id="seo-slug-help">
          Küçük harf, rakam ve tire. Türkçe karakterler otomatik çevrilir (ş→s, ı→i); en fazla{' '}
          {CATEGORY_SLUG_MAX_LENGTH} karakter.
        </span>
      </label>

      <div id="seo-slug-problem" aria-live="polite">
        {localSlug && !problem ? (
          <p className="seo-canonical-preview" data-testid="seo-slug-preview">
            Yeni adres: <code>/categories/{localSlug}</code>
            {checking ? <span className="cell-muted"> · kontrol ediliyor…</span> : null}
          </p>
        ) : null}
        {problem ? (
          <p className="help-text is-error" role="alert" data-testid="seo-slug-problem">
            {problem}
          </p>
        ) : null}
      </div>

      <div className="seo-consequence" data-testid="seo-slug-consequence">
        <strong>Kaydettiğinde ne olacak</strong>
        {createsRedirect ? (
          <>
            <p data-testid="seo-slug-301">{PUBLIC_SLUG_REDIRECT_COPY}</p>
            <p className="cell-muted">
              Bu yönlendirme kapatılamaz; kategori herkese açık olduğu sürece adres değişikliğinin parçasıdır. Site
              haritası yeni adresi bir sonraki istekte gösterir.
            </p>
          </>
        ) : (
          <p data-testid="seo-slug-no-redirect">{NON_PUBLIC_SLUG_REDIRECT_COPY}</p>
        )}
        {retargetCount > 0 ? (
          <p data-testid="seo-slug-retarget">
            Şu anki adrese yönlenen {retargetCount} yönlendirme de yeni adrese çevrilir (zincir oluşmaz).
          </p>
        ) : null}
        {reclaims ? (
          <p data-testid="seo-slug-reclaim">
            Bu adres daha önce bu kategorinindi; o eski adres için tutulan yönlendirme kaldırılır.
          </p>
        ) : null}
      </div>

      {fieldError ? (
        <div className="notice notice-error" role="alert" data-testid="seo-slug-error">
          {fieldError}
        </div>
      ) : null}

      <div className="form-actions">
        <ConfirmDialog
          proof="seo.slug-change"
          triggerLabel="Adresi değiştir"
          triggerClassName="btn btn-primary"
          title={`Adresi değiştir: ${categoryName}`}
          consequence={
            <div data-testid="seo-slug-confirm-body">
              <dl className="confirm-dialog-facts">
                <div>
                  <dt>Şu anki adres</dt>
                  <dd>
                    <code>/categories/{currentSlug}</code>
                  </dd>
                </div>
                <div>
                  <dt>Yeni adres</dt>
                  <dd>
                    <strong>
                      <code>/categories/{localSlug ?? ''}</code>
                    </strong>
                  </dd>
                </div>
              </dl>
              <p>{createsRedirect ? PUBLIC_SLUG_REDIRECT_COPY : NON_PUBLIC_SLUG_REDIRECT_COPY}</p>
              <p>Kategorinin paneldeki adresi de değişir.</p>
            </div>
          }
          confirmLabel="Evet, adresi değiştir"
          tone="primary"
          disabled={!ready}
          testId="seo-slug-submit"
        />
        <Link className="btn btn-secondary" href={cancelHref} scroll={false}>
          Vazgeç
        </Link>
      </div>
    </form>
  );
}
