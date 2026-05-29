import Link from 'next/link';
import { apiFetch, AuthUser, Category, getCurrentUser } from '../lib/api';
import { LandingHero } from './landing-hero';
import { LandingFAQ } from './landing-faq';
import { StartChoiceModal } from './start-choice-modal';
import {
  IconArrowRight,
  IconCheck,
  IconClipList,
  IconCompare,
  IconEdit,
  IconShield,
  IconSnowflake,
  IconThumbsUp,
  IconTrendingUp,
  IconUsers,
  IconWallet,
  IconX,
  iconForCategory,
} from './landing-icons';
import type { IconComponent } from './landing-icons';

const fallbackCategories: Array<{ name: string; slug: string; description: string }> = [
  { name: 'Klima Servisi', slug: 'klima-servisi', description: 'Bakım, arıza ve gaz dolumu' },
  { name: 'Klima Montajı', slug: 'klima-montaji', description: 'Yeni cihaz kurulumu' },
  { name: 'Kombi Servisi', slug: 'kombi-servisi', description: 'Bakım, arıza tespiti' },
  { name: 'Elektrikçi', slug: 'elektrikci', description: 'Tesisat ve arıza onarımı' },
  { name: 'Su Tesisatçısı', slug: 'su-tesisatcisi', description: 'Sızıntı, tıkanıklık, montaj' },
  { name: 'Boya Badana', slug: 'boya-badana', description: 'Daire, oda ve tavan' },
  { name: 'Ev Temizliği', slug: 'ev-temizligi', description: 'Genel ve detay temizlik' },
  { name: 'Nakliyat', slug: 'nakliyat', description: 'Evden eve, ofis taşıma' },
];

export default async function HomePage() {
  let categories: Array<{ name: string; slug: string; description: string | null }> = [];
  try {
    const fromApi = await apiFetch<Category[]>('/categories?limit=10');
    categories = fromApi.length > 0 ? fromApi : fallbackCategories;
  } catch {
    categories = fallbackCategories;
  }

  const user = await getCurrentUser();
  const isCustomer = user?.role === 'CUSTOMER';
  const isAuthenticated = !!user;

  return (
    <>
      <LandingHero isCustomer={isCustomer} isAuthenticated={isAuthenticated} user={user} />
      <PopularCategories categories={categories} />
      <HowItWorks />
      <ProviderValue />
      <Comparison />
      <TrustSection />
      <ProviderCTABand />
      <LandingFAQ />
      <FinalCTA isCustomer={isCustomer} isAuthenticated={isAuthenticated} user={user} />
    </>
  );
}

function PopularCategories({
  categories,
}: {
  categories: Array<{ name: string; slug: string; description: string | null }>;
}) {
  return (
    <section className="lp-section" id="kategoriler">
      <div className="lp-container">
        <div className="lp-section-head">
          <span className="lp-eyebrow">Kategoriler</span>
          <h2 className="lp-h2">En çok talep edilen hizmetler</h2>
          <p className="lp-section-sub">
            Bir kategori seç, kategoriye özel sorulara yanıt ver ve doğrulanmış hizmet verenlerden
            teklifleri karşılaştır.
          </p>
        </div>

        <div className="lp-cat-grid">
          {categories.map((c) => {
            const IconCmp = iconForCategory(c.name);
            return (
              <Link className="lp-cat-card" href={`/categories/${c.slug}`} key={c.slug}>
                <span className="lp-cat-icon">
                  <IconCmp size={22} />
                </span>
                <span className="lp-cat-name">{c.name}</span>
                {c.description ? <span className="lp-cat-desc">{c.description}</span> : null}
                <span className="lp-cat-link">
                  Talep oluştur <IconArrowRight size={12} />
                </span>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}

type Step = {
  n: number;
  title: string;
  desc: string;
  Icon: IconComponent;
};

const steps: Step[] = [
  {
    n: 1,
    Icon: IconEdit,
    title: 'İhtiyacını anlat',
    desc:
      'Kategoriye özel soruları yanıtla, lokasyon ve zaman bilgisini gir. Talebin kalite skoru ile yayına alınır.',
  },
  {
    n: 2,
    Icon: IconCompare,
    title: 'Teklifleri karşılaştır',
    desc:
      'Uygun hizmet verenlerden gelen teklifleri fiyat, deneyim ve açıklamaya göre incele.',
  },
  {
    n: 3,
    Icon: IconThumbsUp,
    title: 'Uygun olanı seç',
    desc:
      'Beğendiğin teklifi kabul et. Ödeme ve iletişim akışı sonraki fazlarda aktif olacaktır.',
  },
];

function HowItWorks() {
  return (
    <section className="lp-section lp-section-white" id="nasil-calisir">
      <div className="lp-container">
        <div className="lp-section-head">
          <span className="lp-eyebrow">Müşteri için</span>
          <h2 className="lp-h2">3 adımda teklif al</h2>
          <p className="lp-section-sub">
            Form doldur, teklifleri karşılaştır, sana uygun olanı seç. Hepsi şeffaf ve takip edilebilir.
          </p>
        </div>

        <div className="lp-steps-grid">
          {steps.map((s) => {
            const { Icon: StepIcon } = s;
            return (
              <article className="lp-step-card" key={s.n}>
                <span className="lp-step-num">{s.n}</span>
                <span className="lp-step-icon">
                  <StepIcon size={20} />
                </span>
                <h3 className="lp-step-title">{s.title}</h3>
                <p className="lp-step-desc">{s.desc}</p>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

const providerFeatures: Array<{ title: string; desc: string }> = [
  {
    title: 'Doğrulanmış talepler',
    desc: 'Telefon doğrulamalı, kategori formuyla detaylandırılmış talepler.',
  },
  {
    title: 'Talep kalite skoru',
    desc: 'Her talebe görüntülenmeden önce algoritmik bir kalite puanı verilir.',
  },
  {
    title: 'Şeffaf kredi kullanımı',
    desc: 'Her teklif için kredi hareketi geçmişe işlenir, anlık olarak görüntülenebilir.',
  },
  {
    title: 'İade önerisi ve refund scan',
    desc: 'Görüntülenmeyen veya geçersiz talepler için iade uygunluğu otomatik taranır.',
  },
  {
    title: 'Kategori ve bölgeye göre eşleşme',
    desc: 'Yalnızca senin uzmanlık alanın ve hizmet bölgendeki taleplerle eşleşirsin.',
  },
];

function ProviderValue() {
  return (
    <section className="lp-section lp-provider-section" id="hizmet-ver">
      <div className="lp-container lp-pv-grid">
        <div className="lp-pv-left">
          <span className="lp-eyebrow">Hizmet verenler için</span>
          <h2 className="lp-h2">Boşa teklif kredisi yakma.</h2>
          <p className="lp-section-sub" style={{ textAlign: 'left', margin: '14px 0 24px' }}>
            TakTic, hizmet verenlerin yalnızca kaliteli ve takip edilebilir taleplere teklif vermesini
            hedefler. Görüntülenmeyen veya geçersiz talepler için iade politikası şeffaftır.
          </p>

          <ul className="lp-pv-features">
            {providerFeatures.map((f) => (
              <li className="lp-pv-feature" key={f.title}>
                <span className="lp-pv-check">
                  <IconCheck size={11} />
                </span>
                <span className="lp-pv-feature-text">
                  <strong>{f.title}.</strong> <span className="lp-muted">{f.desc}</span>
                </span>
              </li>
            ))}
          </ul>

          <div className="lp-pv-cta">
            <Link className="btn btn-primary btn-lg" href="/providers/register">
              Hizmet Veren Ol
            </Link>
            <Link className="btn btn-secondary btn-lg" href="#nasil-calisir">
              Nasıl çalışır?
            </Link>
          </div>
        </div>

        <div className="lp-pv-right">
          <ProviderDashboardMockup />
        </div>
      </div>
    </section>
  );
}

function ProviderDashboardMockup() {
  return (
    <div className="lp-dashboard">
      <div className="lp-dash-head">
        <div className="lp-dash-title">
          <span className="lp-logo-mark lp-logo-mark-sm">T</span>
          <span className="lp-dash-title-text">Hizmet Veren Paneli</span>
        </div>
        <span className="lp-dash-status">
          <span className="lp-dash-dot" />
          <span>Canlı</span>
        </span>
      </div>

      <div className="lp-dash-stats">
        <div className="lp-dash-stat lp-dash-stat-primary">
          <span className="lp-dash-stat-label">Kalan kredi</span>
          <span className="lp-dash-stat-value">24</span>
        </div>
        <div className="lp-dash-stat">
          <span className="lp-dash-stat-label">Eşleşen talep</span>
          <span className="lp-dash-stat-value">8</span>
          <span className="lp-dash-stat-delta">
            <IconTrendingUp size={10} />
            <span>+2 bugün</span>
          </span>
        </div>
        <div className="lp-dash-stat">
          <span className="lp-dash-stat-label">İade kredi</span>
          <span className="lp-dash-stat-value">3</span>
          <span className="lp-dash-stat-delta">son 30 gün</span>
        </div>
      </div>

      <div className="lp-dash-opp-head">
        <span>Yeni teklif fırsatı</span>
        <span className="lp-dash-live">
          <span className="lp-dash-dot lp-dash-dot-primary" />
          1 dakika önce
        </span>
      </div>
      <div className="lp-dash-opp">
        <span className="lp-dash-opp-icon">
          <IconSnowflake size={18} />
        </span>
        <div className="lp-dash-opp-body">
          <div className="lp-dash-opp-title">Klima Servisi · Kadıköy</div>
          <div className="lp-dash-opp-meta">
            <span className="lp-badge lp-badge-success lp-badge-xs">Skor 86</span>
            <span>·</span>
            <span>Bütçe 3.000–5.000 ₺</span>
          </div>
        </div>
        <div className="lp-dash-opp-cost">
          <span className="lp-dash-opp-cost-val">2 kredi</span>
          <span className="lp-dash-opp-cost-label">teklif için</span>
        </div>
      </div>
    </div>
  );
}

const legacyPoints = [
  'Belirsiz müşteri niyeti',
  'Görülmeyen teklifler',
  'Takip edilmesi zor maliyet',
  'Kredi / bakiye nereye gitti belirsiz',
];

const tactıcPoints = [
  'Talep kalite skoru',
  'Görüntülenme takibi',
  'Kredi hareket geçmişi',
  'İade uygunluğu görünürlüğü',
  'Bölge / kategori eşleşmesi',
];

function Comparison() {
  return (
    <section className="lp-section">
      <div className="lp-container">
        <div className="lp-section-head">
          <span className="lp-eyebrow">Karşılaştırma</span>
          <h2 className="lp-h2">Eski modelden daha şeffaf.</h2>
          <p className="lp-section-sub">
            Geleneksel teklif pazaryerlerinin sıkıntılarına karşılık TakTic&apos;in netliği.
          </p>
        </div>

        <div className="lp-comp-grid">
          <div className="lp-comp-card lp-comp-legacy">
            <div className="lp-comp-head">
              <span className="lp-comp-title">Geleneksel teklif modeli</span>
              <span className="lp-badge lp-badge-neutral">Eski yöntem</span>
            </div>
            <div className="lp-comp-list">
              {legacyPoints.map((t) => (
                <div key={t} className="lp-comp-item">
                  <span className="lp-comp-mark lp-comp-mark-neutral">
                    <IconX size={10} />
                  </span>
                  <span>{t}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="lp-comp-card lp-comp-taktic">
            <div className="lp-comp-head">
              <span className="lp-comp-title lp-comp-title-primary">TakTic modeli</span>
              <span className="lp-badge lp-badge-primary">Şeffaf</span>
            </div>
            <div className="lp-comp-list">
              {tactıcPoints.map((t) => (
                <div key={t} className="lp-comp-item">
                  <span className="lp-comp-mark lp-comp-mark-success">
                    <IconCheck size={11} />
                  </span>
                  <span className="lp-comp-item-strong">{t}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const trustCards: Array<{
  title: string;
  desc: string;
  Icon: IconComponent;
}> = [
  {
    Icon: IconClipList,
    title: 'Kategorilere özel talep formları',
    desc: 'Her kategori için doğru bilgiyi toplayan özel form akışı.',
  },
  {
    Icon: IconShield,
    title: 'Admin ön inceleme',
    desc: 'Talepler yayına alınmadan önce inceleme süreçlerinden geçer.',
  },
  {
    Icon: IconUsers,
    title: 'Hizmet veren onay süreci',
    desc: 'Yalnızca başvurusu onaylanmış profesyoneller teklif verir.',
  },
  {
    Icon: IconWallet,
    title: 'Teklif ve kredi geçmişi',
    desc: 'Her teklif ve kredi hareketi geçmişe kalır, anlık görünür.',
  },
];

const trustStats = [
  { v: '7', l: 'Aktif kategori' },
  { v: '100%', l: 'Kalite skorlu talepler' },
  { v: '0₺', l: 'Görüntülenmeyen teklif maliyeti' },
  { v: 'Açık', l: 'İade politikası' },
];

function TrustSection() {
  return (
    <section className="lp-section lp-section-white">
      <div className="lp-container">
        <div className="lp-section-head">
          <span className="lp-eyebrow">Güven</span>
          <h2 className="lp-h2">Daha güvenli hizmet pazaryeri deneyimi</h2>
          <p className="lp-section-sub">
            Talep, teklif ve kredi akışını izlenebilir kılan altyapı.
          </p>
        </div>

        <div className="lp-trust-grid">
          {trustCards.map(({ title, desc, Icon: TrustIcon }) => (
            <article className="lp-trust-card" key={title}>
              <span className="lp-trust-icon">
                <TrustIcon size={18} />
              </span>
              <h3 className="lp-trust-title">{title}</h3>
              <p className="lp-trust-desc">{desc}</p>
            </article>
          ))}
        </div>

        <div className="lp-trust-stats">
          {trustStats.map((s) => (
            <div className="lp-trust-stat" key={s.l}>
              <div className="lp-trust-stat-value">{s.v}</div>
              <div className="lp-trust-stat-label">{s.l}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const ctaBullets = [
  'Kategori seç',
  'Hizmet bölgeni belirle',
  'Admin onayından sonra talepleri gör',
  'Krediyle teklif ver',
];

function ProviderCTABand() {
  return (
    <section className="lp-section">
      <div className="lp-container">
        <div className="lp-cta-band">
          <div>
            <span className="lp-eyebrow lp-eyebrow-light">Hizmet verenler için</span>
            <h2 className="lp-h2 lp-cta-band-title">
              Hizmet veriyorsan, doğru müşteriye teklif ver.
            </h2>
            <p className="lp-cta-band-sub">
              Bölgen ve uzmanlık alanlarınla eşleşen talepleri gör, tekliflerini takip et, kredi
              hareketlerini şeffaf şekilde izle.
            </p>
            <Link className="btn btn-primary btn-lg lp-cta-band-btn" href="/providers/register">
              Hizmet Veren Başvurusu Yap
              <IconArrowRight />
            </Link>
          </div>
          <div className="lp-cta-band-bullets">
            {ctaBullets.map((b, i) => (
              <div className="lp-cta-band-bullet" key={b}>
                <span className="lp-cta-band-bullet-num">{i + 1}</span>
                <span>{b}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function FinalCTA({
  isCustomer = false,
  isAuthenticated = false,
  user = null,
}: {
  isCustomer?: boolean;
  isAuthenticated?: boolean;
  user?: AuthUser | null;
}) {
  const heading = isCustomer
    ? 'İhtiyacın olan hizmet için yeni talebini oluştur.'
    : 'İhtiyacın olan hizmet için ilk talebini oluştur.';

  return (
    <section className="lp-final-cta">
      <div className="lp-container">
        <h2 className="lp-h2">{heading}</h2>
        <p className="lp-final-cta-sub">
          Birkaç dakikada talebini gönder, doğrulanmış hizmet verenlerden teklifleri karşılaştır.
        </p>
        <div className="lp-final-cta-buttons">
          {isAuthenticated ? (
            <Link className="btn btn-primary btn-lg" href="/categories">
              {isCustomer ? 'Yeni Talep Oluştur' : 'Hizmet Al'}
            </Link>
          ) : (
            <StartChoiceModal user={user} className="btn btn-primary btn-lg" />
          )}
          {isCustomer ? (
            <Link className="btn btn-secondary btn-lg" href="/requests/my">
              Taleplerim
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}
