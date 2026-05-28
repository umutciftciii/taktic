import Link from 'next/link';

const cols: Array<{ title: string; links: Array<{ label: string; href: string }> }> = [
  {
    title: 'Hizmetler',
    links: [
      { label: 'Tüm Kategoriler', href: '/categories' },
      { label: 'Klima', href: '/categories?q=klima' },
      { label: 'Kombi', href: '/categories?q=kombi' },
      { label: 'Elektrikçi', href: '/categories?q=elektrik' },
      { label: 'Temizlik', href: '/categories?q=temiz' },
      { label: 'Nakliyat', href: '/categories?q=nakli' },
    ],
  },
  {
    title: 'Hizmet Veren',
    links: [
      { label: 'Başvuru Yap', href: '/providers/register' },
      { label: 'Hesap Oluştur', href: '/register/provider' },
      { label: 'Hizmet Veren Paneli', href: '/providers/me' },
      { label: 'Nasıl Çalışır', href: '/#nasil-calisir' },
    ],
  },
  {
    title: 'Yardım',
    links: [
      { label: 'Sık Sorulanlar', href: '/#lp-sss' },
      { label: 'Nasıl Çalışır', href: '/#nasil-calisir' },
      { label: 'Giriş Yap', href: '/login' },
      { label: 'Taleplerim', href: '/requests/my' },
    ],
  },
  {
    title: 'Yasal',
    links: [
      { label: 'Kullanım Şartları', href: '#' },
      { label: 'Gizlilik', href: '#' },
      { label: 'KVKK', href: '#' },
      { label: 'Çerez Politikası', href: '#' },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="lp-footer">
      <div className="lp-container">
        <div className="lp-footer-grid">
          <div className="lp-footer-brand">
            <Link className="lp-footer-logo" href="/">
              <span className="lp-logo-mark">T</span>
              <span>TakTic</span>
            </Link>
            <p>
              Doğrulanmış talepler ve adil teklif kredisiyle, daha şeffaf bir yerel hizmet pazaryeri.
            </p>
          </div>

          {cols.map((c) => (
            <div className="lp-footer-col" key={c.title}>
              <h4>{c.title}</h4>
              <ul>
                {c.links.map((l) => (
                  <li key={l.label}>
                    <Link href={l.href}>{l.label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="lp-footer-bottom">
          <div>© {new Date().getFullYear()} TakTic. Tüm hakları saklıdır.</div>
          <div className="lp-footer-legal">
            <Link href="#">Kullanım Şartları</Link>
            <Link href="#">Gizlilik</Link>
            <Link href="#">KVKK</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
