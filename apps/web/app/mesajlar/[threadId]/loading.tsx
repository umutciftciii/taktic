/** The conversation's own loading state — see ../loading.tsx. */
export default function ThreadLoading() {
  return (
    <div className="cdash-empty" role="status" aria-live="polite" data-testid="thread-loading">
      <h3>Konuşma yükleniyor…</h3>
      <p>Mesaj geçmişi getiriliyor.</p>
    </div>
  );
}
