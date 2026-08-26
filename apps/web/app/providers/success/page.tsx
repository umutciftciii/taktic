import { cookies } from 'next/headers';
import Link from 'next/link';
import { APPLY_HINT_COOKIE, isProviderClaimEnabled } from '../../../lib/provider-claim';

/**
 * The application confirmation.
 *
 * It deliberately takes no parameters. The previous version carried the new
 * application's id in its URL, which put a record identifier into browser
 * history — and into anything the applicant pasted the link into — for no
 * benefit, since the id opens nothing and proves nothing. What replaces it is
 * the only thing the applicant needs next: which mailbox to check, masked, read
 * from a short-lived cookie so no address reaches a URL either.
 */
export default async function ProviderSuccessPage() {
  const claimEnabled = isProviderClaimEnabled();
  const maskedEmail = claimEnabled
    ? ((await cookies()).get(APPLY_HINT_COOKIE)?.value ?? null)
    : null;

  return (
    <main>
      <div className="page-narrow">
        <section>
          <span className="kicker">Başvuru alındı</span>
          <h1 className="page-title">Başvurunuz ön incelemeye gönderildi</h1>
          <p className="page-subtitle">
            Onay sonrasında eşleşen taleplere teklif vermeye başlayabilirsiniz.
          </p>

          {claimEnabled ? (
            <div className="rail-note" style={{ marginTop: 24 }} data-testid="claim-mail-notice">
              <h2 style={{ fontSize: 16, marginTop: 0 }}>E-postanızı kontrol edin</h2>
              <p className="muted" style={{ marginBottom: 0 }}>
                {maskedEmail ? (
                  <>
                    Başvurunuzu kendi hesabınıza bağlayabilmeniz için <strong>{maskedEmail}</strong>{' '}
                    adresine bir bağlantı gönderdik.
                  </>
                ) : (
                  <>
                    Başvurunuzu kendi hesabınıza bağlayabilmeniz için başvuruda verdiğiniz e-posta
                    adresine bir bağlantı gönderdik.
                  </>
                )}{' '}
                Bağlantı 72 saat geçerlidir.
              </p>
            </div>
          ) : null}

          <div className="inline-actions" style={{ marginTop: 24 }}>
            <Link className="btn btn-primary" href="/providers/me">Hizmet Veren Paneli</Link>
            <Link className="btn btn-secondary" href="/">Ana sayfa</Link>
          </div>
        </section>
      </div>
    </main>
  );
}
