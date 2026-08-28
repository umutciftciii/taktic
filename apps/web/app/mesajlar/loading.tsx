/**
 * What the inbox shows while it is being read.
 *
 * The thread list is a server render behind two API calls, so on a slow
 * connection the panel would otherwise hold the previous screen and look stuck.
 * This says which of the three states it is in — loading, not empty and not
 * broken — which is the distinction the empty state and the error notice on the
 * page itself exist to make.
 */
export default function MessagesLoading() {
  return (
    <div className="cdash-empty" role="status" aria-live="polite" data-testid="thread-list-loading">
      <h3>Mesajlar yükleniyor…</h3>
      <p>Konuşmalarınız getiriliyor.</p>
    </div>
  );
}
