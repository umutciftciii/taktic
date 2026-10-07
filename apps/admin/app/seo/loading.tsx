/**
 * The SEO screens while the API computes their figures (SEO-004 PR B): the
 * overview and the non-indexable list evaluate every public page on request,
 * so the wait is real. A plain status line, announced once — no skeleton
 * numbers that could be read as data.
 */
export default function SeoLoading() {
  return (
    <div className="seo-page">
      <section className="system-state" role="status" aria-live="polite" data-testid="seo-loading">
        <p className="system-state-kicker">SEO ve adresler</p>
        <p className="system-state-body">Yükleniyor…</p>
      </section>
    </div>
  );
}
