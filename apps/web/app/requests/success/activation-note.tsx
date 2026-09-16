import Link from 'next/link';

/**
 * The activation note on the guest receipt.
 *
 * One sentence with one link in it. It is rendered as prose — `notice-prose`
 * turns the notice box's flex row back into a block — because a paragraph
 * with a link in the middle is otherwise laid out as three columns: the words
 * before the link, the link, the words after it.
 *
 * The visitor has no session, so the note tells them what to do and nothing
 * about the request: no status, no business, no offer.
 */
export function GuestActivationNote() {
  return (
    <p
      className="notice notice-prose"
      role="status"
      data-testid="request-success-activation-note"
      style={{ marginTop: 14 }}
    >
      Hesabınızı etkinleştirmeniz için e-posta adresinize bir bağlantı gönderdik. E-postanızı
      kontrol edin; bağlantı ulaşmadıysa aynı e-posta adresiyle{' '}
      <Link href="/register/customer">kayıt olmayı</Link> deneyin, bağlantı yeniden
      gönderilir.
    </p>
  );
}
