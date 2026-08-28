import Link from 'next/link';
import type { Metadata } from 'next';

/**
 * The contact-sharing disclosure this platform serves itself.
 *
 * It exists so the product's default configuration points at a text that
 * provably exists: the page is versioned in the repository next to the code
 * that references it, and it is served from the customer's own origin rather
 * than a host that may or may not answer. A deployment with its own published
 * legal page overrides CONTACT_DISCLOSURE_URL and this page stops being linked.
 *
 * The version identifier below is the one the API stores against an acceptance
 * (BUILT_IN_DISCLOSURE_VERSION in contact-sharing.config.ts). If the wording
 * here changes in a way a customer would need to see again, both move together
 * and every acceptance already on file is asked for once more.
 *
 * Deliberately static: no data is read, so nothing here can be personalised,
 * and there is no runtime state for a server and a client render to disagree
 * about.
 */

export const metadata: Metadata = {
  title: 'İletişim Bilgisi Paylaşımı Aydınlatma Metni · TakTick',
  description:
    'Bir teklifi kabul ettiğinizde hangi iletişim bilgilerinizin, kiminle ve hangi amaçla paylaşıldığı.',
};

export default function ContactSharingDisclosurePage() {
  return (
    <main className="lp-container" style={{ maxWidth: 760, padding: '48px 20px 72px' }}>
      <p className="kicker">Aydınlatma metni</p>
      <h1 style={{ marginTop: 8 }}>İletişim bilgisi paylaşımı</h1>
      <p className="muted" data-testid="disclosure-version">
        Sürüm: taktic-2026-08-v1
      </p>

      <section style={{ marginTop: 28 }}>
        <h2>Paylaşım ne zaman olur?</h2>
        <p>
          İletişim bilgileriniz, yalnızca <strong>bir teklifi kabul ettiğiniz anda</strong> ve
          yalnızca <strong>teklifini kabul ettiğiniz hizmet verenle</strong> paylaşılır. Talebinizi
          oluşturmanız, teklif alması veya teklifleri incelemeniz hiçbir iletişim bilgisi paylaşımı
          doğurmaz.
        </p>
      </section>

      <section style={{ marginTop: 28 }}>
        <h2>Hangi bilgiler paylaşılır?</h2>
        <p>Kabul ettiğiniz hizmet veren şunları görür:</p>
        <ul>
          <li>Talepte belirttiğiniz ad soyad</li>
          <li>Talepte belirttiğiniz telefon numarası</li>
          <li>Talepte belirttiğiniz e-posta adresi</li>
        </ul>
        <p>Siz de kabul ettiğiniz hizmet verenin şu bilgilerini görürsünüz:</p>
        <ul>
          <li>İşletme adı ve yetkili kişi adı</li>
          <li>Telefon numarası ve e-posta adresi</li>
          <li>İl ve ilçe</li>
        </ul>
        <p>
          <strong>Paylaşılmayanlar:</strong> açık adresiniz, adres notunuz, mahalleniz, vergi
          bilgileri ve platform içi kayıt numaraları hiçbir aşamada karşı tarafa gösterilmez.
        </p>
      </section>

      <section style={{ marginTop: 28 }}>
        <h2>Kimler göremez?</h2>
        <p>
          Teklif veren ancak seçilmeyen hizmet verenler, teklifini geri çeken veya reddedilen
          hizmet verenler ve talebinizle ilgisi olmayan kullanıcılar iletişim bilgilerinize hiçbir
          aşamada erişemez. Erişim, yalnızca kabul ettiğiniz teklifin sahibi ile sınırlıdır.
        </p>
      </section>

      <section style={{ marginTop: 28 }}>
        <h2>Amaç ve süre</h2>
        <p>
          Paylaşımın tek amacı, kabul edilen iş için iki tarafın doğrudan iletişim kurabilmesidir.
          Her paylaşım, hangi talep ve hangi teklif için yapıldığı bilgisiyle birlikte kayıt altına
          alınır; bu kayıt, paylaşımın neden yapıldığının sonradan gösterilebilmesi içindir.
        </p>
      </section>

      <section style={{ marginTop: 28 }}>
        <h2>Onayınız</h2>
        <p>
          Bu metni, bir teklifi kabul etmeden hemen önce onaylarsınız. Onay vermeden teklif kabulü
          tamamlanmaz. Teklifi kabul etmemeyi seçerseniz hiçbir iletişim bilginiz paylaşılmaz.
        </p>
      </section>

      <p style={{ marginTop: 36 }}>
        <Link className="cdash-btn cdash-btn-secondary" href="/">
          Ana sayfaya dön
        </Link>
      </p>
    </main>
  );
}
