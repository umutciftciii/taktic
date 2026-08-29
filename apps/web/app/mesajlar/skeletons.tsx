/**
 * The messaging screens' loading states.
 *
 * These used to be `loading.tsx` route files, and that was the bug. A
 * `loading.tsx` puts a Suspense boundary around the whole segment — above the
 * page, and therefore above the page's own "is anybody signed in" check — so
 * Next.js committed a 200 and streamed this skeleton to an anonymous visitor
 * before it ever learned there was nobody to show it to. The sign-in redirect
 * then arrived as a meta refresh inside that already-sent shell instead of as
 * the 307 every other protected route answers with.
 *
 * As plain components they are rendered by an explicit `<Suspense>` that each
 * page opens *after* it has a user, which is the only moment a "yükleniyor"
 * message is true: somebody who may read this screen is waiting for it.
 */

/**
 * What the inbox shows while it is being read.
 *
 * The thread list is a server render behind two API calls, so on a slow
 * connection the panel would otherwise hold the previous screen and look stuck.
 * This says which of the three states it is in — loading, not empty and not
 * broken — which is the distinction the empty state and the error notice on the
 * page itself exist to make.
 */
export function ThreadListSkeleton() {
  return (
    <div className="cdash-empty" role="status" aria-live="polite" data-testid="thread-list-loading">
      <h3>Mesajlar yükleniyor…</h3>
      <p>Konuşmalarınız getiriliyor.</p>
    </div>
  );
}

/** The conversation's own loading state — see above. */
export function ThreadSkeleton() {
  return (
    <div className="cdash-empty" role="status" aria-live="polite" data-testid="thread-loading">
      <h3>Konuşma yükleniyor…</h3>
      <p>Mesaj geçmişi getiriliyor.</p>
    </div>
  );
}
