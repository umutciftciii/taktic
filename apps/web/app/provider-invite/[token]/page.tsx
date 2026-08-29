import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCurrentUser } from '../../../lib/api';
import type { ProvinceWithDistricts } from '../../../lib/locations';
import { isProviderClaimEnabled } from '../../../lib/provider-claim';
import { IconArrowRight } from '../../landing-icons';
import { ProviderApplicationFields } from '../../providers/provider-application-fields';
import { submitInvitedApplicationAction } from './actions';

const apiUrl =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * The one page in this application whose URL carries a credential.
 *
 * `no-referrer` is not decoration. Without it every asset request and every
 * outbound link from this page would carry the full URL — token included — in a
 * `Referer` header, which is precisely how a single-use link ends up in a third
 * party's logs. `noindex, nofollow` keeps a link somebody pastes into a public
 * place out of a search index, where it would sit long after it expired.
 */
export const metadata: Metadata = {
  title: 'Hizmet Veren Başvuru Daveti — TakTic',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

type ProviderInvitePageProps = {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
};

type InviteDescription = {
  valid: true;
  /** The one fact this page may show about an unreleased service. */
  categoryName: string;
  expiresAt: string;
};

/** What the applicant is told when their submission came back refused. */
const SUBMIT_ERRORS: Record<string, string> = {
  used:
    'Bu davet bağlantısı başka bir başvuruda kullanıldı. Başvurunuz kaydedilmedi; bağlantıyı ileten kişiden yeni bir davet isteyin.',
  email: 'Geçerli bir e-posta adresi girin; başvurunuzu bu adrese bağlayacağız.',
  account:
    'Bu hesapla hizmet veren başvurusu gönderilemiyor. Çıkış yapıp tekrar deneyin ya da mevcut hizmet veren panelinizi kullanın.',
  invalid: 'Başvuru gönderilemedi. Alanları kontrol edip tekrar deneyin.',
};

/**
 * Reads the invitation without spending it.
 *
 * Every failure — unknown, spent, withdrawn, expired, or a service that has
 * since been closed — comes back as the same 404, and this turns all of them
 * into the site's ordinary "page not found" screen. That is the same screen a
 * mistyped URL produces, so a visitor holding a dead link learns nothing about
 * which of the five it was, and neither does anybody feeding the route guesses.
 */
async function describeInvite(token: string): Promise<InviteDescription | null> {
  try {
    const response = await fetch(
      `${apiUrl}/provider-invites/${encodeURIComponent(token)}`,
      { cache: 'no-store', headers: { accept: 'application/json' } },
    );

    return response.ok ? ((await response.json()) as InviteDescription) : null;
  } catch {
    // A transport failure is not a verdict about the link, but there is nothing
    // to render either, and the honest shared answer is the same page.
    return null;
  }
}

export default async function ProviderInvitePage({
  params,
  searchParams,
}: ProviderInvitePageProps) {
  const [{ token }, { error }] = await Promise.all([params, searchParams]);
  const invite = await describeInvite(token);

  if (!invite) {
    notFound();
  }

  const [user, provinces] = await Promise.all([
    getCurrentUser(),
    // The canonical province/district list, from the same API that validates
    // the submitted application — exactly as the open form loads it.
    fetchProvinces(),
  ]);

  const emailRequired = isProviderClaimEnabled() && user?.role !== 'PROVIDER';
  const submitError = error ? SUBMIT_ERRORS[error] : undefined;

  return (
    <div className="provider-apply-shell">
      <section className="provider-apply-hero">
        <div className="lp-container">
          <span className="kicker">Davetli başvuru</span>
          <h1 className="provider-apply-title">Bu hizmet için başvuru davetiniz var</h1>
          {/*
            The service's name, and nothing else about it. Not the description,
            not the questions its customers will answer, not what an offer will
            cost, not who else is behind it — an invitation says "we would like
            you to apply for this", and the rest of an unreleased service's
            catalogue entry is not the invited business's to read.
          */}
          <p className="provider-apply-invited-service" data-testid="invite-category">
            {invite.categoryName}
          </p>
          <p>
            İşletme bilgilerinizi paylaşın ve hizmet bölgenizi belirtin. Başvurunuz yukarıdaki
            hizmete bağlanır; onay sonrasında eşleşen taleplere teklif verebilirsiniz.
          </p>
        </div>
      </section>

      <div className="provider-apply-container">
        {submitError ? (
          <div className="provider-apply-notice is-warning" role="alert" data-testid="invite-error">
            <span className="provider-apply-notice-icon" aria-hidden="true">!</span>
            <span>{submitError}</span>
          </div>
        ) : null}

        <div className="provider-apply-notice" role="status">
          <span className="provider-apply-notice-icon" aria-hidden="true">i</span>
          <span>
            Bu davet bağlantısı tek kullanımlıktır ve bir kez gönderdikten sonra tekrar
            kullanılamaz.
          </span>
        </div>

        {user?.role === 'CUSTOMER' ? (
          <div className="provider-apply-notice is-warning" role="status">
            <span className="provider-apply-notice-icon" aria-hidden="true">!</span>
            <span>Müşteri hesabıyla hizmet veren profili oluşturulamaz.</span>
          </div>
        ) : null}

        <div className="provider-apply-body">
          <form action={submitInvitedApplicationAction} className="provider-apply-form">
            {/*
              The token rides in the body, which is the whole reason it is a
              hidden field rather than something the action reads back out of
              the URL: from here on it is never in a query string this
              application writes.
            */}
            <input name="token" type="hidden" value={token} />
            <ProviderApplicationFields
              emailRequired={emailRequired}
              provinces={provinces}
              serviceScope={
                <section className="provider-apply-card">
                  <div className="provider-apply-card-head">
                    <h2 className="provider-apply-card-title">
                      <span className="provider-apply-card-num">04</span>
                      Hizmet kapsamı
                    </h2>
                    <p className="provider-apply-card-subtitle">
                      Bu davet tek bir hizmet için geçerlidir.
                    </p>
                  </div>
                  {/*
                    Stated, not chosen. The binding is derived from the
                    invitation on the server, so there is no field here for a
                    browser to send and nothing a modified page could change.
                  */}
                  <p className="provider-apply-invited-scope">
                    <strong>{invite.categoryName}</strong>
                  </p>
                </section>
              }
            />

            <div className="provider-apply-actions">
              <button className="provider-apply-submit" type="submit">
                Başvuruyu Gönder
                <IconArrowRight />
              </button>
              <Link className="provider-apply-cancel" href="/">
                Vazgeç
              </Link>
              <span className="provider-apply-required-note">* zorunlu alanlar</span>
            </div>
          </form>

          <aside className="provider-apply-rail" aria-label="Davet bilgilendirmesi">
            <div className="rail-panel">
              <span className="rail-title">Bu davet nasıl çalışır?</span>
              <ol className="rail-steps">
                <li className="rail-step">
                  <span className="rail-step-num">01</span>
                  <span>
                    <strong>Formu doldurun.</strong> Başvurunuz yalnızca{' '}
                    {invite.categoryName} hizmetine bağlanır.
                  </span>
                </li>
                <li className="rail-step">
                  <span className="rail-step-num">02</span>
                  <span>
                    <strong>Ön inceleme.</strong> Ekibimiz başvuruyu inceler; eksik bilgi varsa
                    iletişime geçilir.
                  </span>
                </li>
                <li className="rail-step">
                  <span className="rail-step-num">03</span>
                  <span>
                    <strong>Onay.</strong> Onaydan sonra bu hizmet yayına alındığında eşleşen
                    talepler panelinizde görünür.
                  </span>
                </li>
              </ol>
            </div>

            <div className="rail-note">
              <strong>Bağlantıyı paylaşmayın.</strong> Bu adres tek kullanımlıktır: başkasının
              elinde, başvuruyu sizin yerinize o kişi gönderebilir.
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

async function fetchProvinces(): Promise<ProvinceWithDistricts[]> {
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${apiUrl}/locations/provinces`, {
    cache: 'no-store',
    headers: {
      accept: 'application/json',
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
  });

  if (!response.ok) {
    // Without the province list the address selects have nothing to offer, and
    // an address the API will refuse is worse than an honest empty form.
    return [];
  }

  return (await response.json()) as ProvinceWithDistricts[];
}
