/**
 * The SEO screens while the API computes their figures (SEO-004 PR B): the
 * overview and the non-indexable list evaluate every public page on request,
 * so the wait is real. A plain status line, announced once — no skeleton
 * numbers that could be read as data.
 *
 * Only those two screens have a `loading.tsx` (`(overview)/loading.tsx`,
 * `indexing/loading.tsx`), and it must stay that way
 * (BUG-SEO-ADMIN-MODAL-NAV-001). A `loading.tsx` directly under `app/seo`
 * wraps every SEO screen in one Suspense boundary that stays mounted while a
 * screen changes only its query: `/seo/redirects?…` → `?…&oneri=…`. A soft
 * navigation is a transition, and React will not swap an already visible
 * boundary back to its fallback in a transition — it keeps the old screen and
 * waits. When the new page then suspends on its window's client component
 * (the RSC row for `RouteDialog` waits for its module), that wait was
 * intermittently never retried: the 200 arrived, nothing committed, the URL
 * did not move and the window did not open. Placed beside a page, the
 * boundary is keyed by that page's own query and is new on every navigation,
 * so a transition can show it — and the query-driven windows on /seo/redirects
 * and /seo/slugs have no boundary above them at all, like every other screen.
 */
export function SeoLoading() {
  return (
    <div className="seo-page">
      <section className="system-state" role="status" aria-live="polite" data-testid="seo-loading">
        <p className="system-state-kicker">SEO ve adresler</p>
        <p className="system-state-body">Yükleniyor…</p>
      </section>
    </div>
  );
}
