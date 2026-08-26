import Link from 'next/link';
import { apiFetch, AuthUser, Category, getCurrentUser } from '../lib/api';
import { LandingHero } from './landing-hero';
import { LandingFAQ } from './landing-faq';
import { StartChoiceModal } from './start-choice-modal';
import { CategoryVisual } from './category-visual';
import {
  IconArrowRight,
  IconCheck,
  IconClipList,
  IconCompare,
  IconEdit,
  IconShield,
  IconThumbsUp,
  IconUsers,
  IconWallet,
  IconX,
} from './landing-icons';
import type { IconComponent } from './landing-icons';

export default async function HomePage() {
  /*
   * Categories are the API's to answer. There is no stand-in list any more: a
   * fabricated grid would put category names on screen that nothing behind them
   * can serve, so an unreachable API renders the empty state instead.
   */
  let categories: Category[] = [];
  try {
    categories = await apiFetch<Category[]>('/categories?limit=10');
  } catch {
    categories = [];
  }

  const user = await getCurrentUser();
  const isCustomer = user?.role === 'CUSTOMER';
  const isAuthenticated = !!user;

  return (
    <>
      <LandingHero isCustomer={isCustomer} isAuthenticated={isAuthenticated} user={user} />
      <MetricStrip categoryCount={categories.length} />
      <PopularCategories categories={categories} />
      <HowItWorks />
      <ProviderValue />
      <Comparison />
      <ProviderCTABand />
      <LandingFAQ />
      <FinalCTA isCustomer={isCustomer} isAuthenticated={isAuthenticated} user={user} />
    </>
  );
}

/**
 * The metric strip states only what the platform's own rules guarantee, plus
 * the live category count. Nothing here is a volume claim: there is no marketplace
 * figure this page could read that would still be true tomorrow.
 */
function MetricStrip({ categoryCount }: { categoryCount: number }) {
  return (
    <section className="lp-section" style={{ paddingTop: 0, paddingBottom: 0 }}>
      <div className="lp-container">
        <div className="metric-strip">
          <div className="metric-cell">
            <span className="metric-label">Aktif kategori</span>
            <span className="metric-value">{categoryCount}</span>
            <span className="metric-hint">kategoriye özel form</span>
          </div>
          <div className="metric-cell">
            <span className="metric-label">Talep geçerliliği</span>
            <span className="metric-value">14</span>
            <span className="metric-hint">gün</span>
          </div>
          <div className="metric-cell">
            <span className="metric-label">Teklif almak</span>
            <span className="metric-value">0 ₺</span>
            <span className="metric-hint">müşteri için ücretsiz</span>
          </div>
          <div className="metric-cell">
            <span className="metric-label">Kalite skoru</span>
            <span className="metric-value">%100</span>
            <span className="metric-hint">her talep puanlanır</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function PopularCategories({ categories }: { categories: Category[] }) {
  return (
    <section className="lp-section" id="kategoriler">
      <div className="lp-container">
        <div className="lp-section-head">
          <div>
            <span className="lp-eyebrow">Kategoriler</span>
            <h2 className="lp-h2">En çok talep edilen hizmetler</h2>
          </div>
          <p className="lp-section-sub">
            Bir kategori seç, kategoriye özel sorulara yanıt ver ve gelen teklifleri karşılaştır.
          </p>
        </div>

        {categories.length === 0 ? (
          <div className="state-surface">
            <h3>Kategoriler şu anda listelenemiyor</h3>
            <p>
              Kategori listesi birazdan tekrar yüklenecek. Bu sırada tüm kategoriler sayfasından
              arama yapabilirsiniz.
            </p>
            <Link className="btn btn-secondary" href="/categories">
              Kategorilere git
            </Link>
          </div>
        ) : (
          <div className="lp-cat-grid">
            {categories.map((c) => (
              <Link className="lp-cat-card" href={`/categories/${c.slug}`} key={c.slug}>
                <span className="lp-cat-media">
                  <CategoryVisual
                    imageUrl={c.imageUrl}
                    slug={c.slug}
                    iconKey={c.iconKey}
                    name={c.name}
                    imgClassName="lp-cat-img"
                    iconWrapperClassName="lp-cat-icon"
                    iconSize={32}
                    alt=""
                  />
                </span>
                <span className="lp-cat-name">{c.name}</span>
                {c.description ? <span className="lp-cat-desc">{c.description}</span> : null}
                <span className="lp-cat-link">
                  Talep oluştur <IconArrowRight size={12} />
                </span>
              </Link>
            ))}

            <Link className="lp-cat-cta-cell" href="/categories">
              <span className="lp-cat-name">Tüm kategorileri gör</span>
              <span className="lp-cat-desc">Arama ve filtrelerle doğru kategoriyi bul.</span>
              <span className="lp-cat-link">
                Kategoriler <IconArrowRight size={12} />
              </span>
            </Link>
          </div>
        )}
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
      'Beğendiğin teklifi kabul et; eşleşme kaydedildiğinde iletişim bilgileri karşılıklı paylaşılır.',
  },
];

function HowItWorks() {
  return (
    <section className="lp-section lp-section-white" id="nasil-calisir">
      <div className="lp-container">
        <div className="lp-section-head">
          <div>
            <span className="lp-eyebrow">Müşteri için</span>
            <h2 className="lp-h2">3 adımda teklif al</h2>
          </div>
          <p className="lp-section-sub">
            Form doldur, teklifleri karşılaştır, sana uygun olanı seç. Hepsi şeffaf ve takip
            edilebilir.
          </p>
        </div>

        <div className="lp-steps-grid">
          {steps.map((s) => {
            const { Icon: StepIcon } = s;
            return (
              <article className="lp-step-card" key={s.n}>
                <span className="lp-step-num">0{s.n}</span>
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
    title: 'İncelenmiş talepler',
    desc: 'Kategori formuyla detaylandırılan talepler, yayına alınmadan önce incelenir.',
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
    title: 'İade önerisi ve iade taraması',
    desc: 'Görüntülenmeyen veya geçersiz talepler için iade uygunluğu otomatik taranır.',
  },
  {
    title: 'Kategori ve bölgeye göre eşleşme',
    desc: 'Yalnızca senin uzmanlık alanın ve hizmet bölgendeki taleplerle eşleşirsin.',
  },
];

function ProviderValue() {
  return (
    <section className="lp-section" id="hizmet-ver">
      <div className="lp-container">
        <div className="lp-section-head">
          <div>
            <span className="lp-eyebrow">Hizmet verenler için</span>
            <h2 className="lp-h2">Boşa teklif kredisi yakma.</h2>
          </div>
        </div>

        <div className="lp-pv-grid">
          <div className="lp-pv-left">
            <p className="lp-section-sub" style={{ marginTop: 0 }}>
              TakTic, hizmet verenlerin yalnızca kaliteli ve takip edilebilir taleplere teklif
              vermesini hedefler. Görüntülenmeyen veya geçersiz talepler için iade politikası
              şeffaftır.
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
                <IconArrowRight />
              </Link>
              <Link className="btn btn-secondary btn-lg" href="#nasil-calisir">
                Nasıl çalışır?
              </Link>
            </div>
          </div>

          <div className="lp-pv-right">
            <ProviderPanelPreview />
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * A drawing of the provider panel, not a data readout. It carries labels only —
 * no counts, balances or prices — because nothing on a public page can know a
 * provider's real numbers, and a plausible-looking figure here would be a claim.
 */
function ProviderPanelPreview() {
  return (
    <div className="lp-dashboard">
      <div className="lp-dash-head">
        <div className="lp-dash-title">
          <span className="lp-logo-mark lp-logo-mark-sm">T</span>
          <span className="lp-dash-title-text">Hizmet Veren Paneli</span>
        </div>
        <span className="lp-dash-status">
          <span className="lp-dash-dot" />
          <span>Önizleme</span>
        </span>
      </div>

      <div className="lp-dash-stats">
        <div className="lp-dash-stat">
          <span className="lp-dash-stat-label">Kredi bakiyesi</span>
          <span className="lp-dash-stat-delta">panelinde</span>
        </div>
        <div className="lp-dash-stat">
          <span className="lp-dash-stat-label">Uygun talep</span>
          <span className="lp-dash-stat-delta">bölgene göre</span>
        </div>
        <div className="lp-dash-stat">
          <span className="lp-dash-stat-label">İade kredi</span>
          <span className="lp-dash-stat-delta">otomatik tarama</span>
        </div>
      </div>

      <div className="lp-dash-opp-head">
        <span>Yeni teklif fırsatı</span>
      </div>
      <div className="lp-dash-opp">
        <span className="lp-dash-opp-icon">
          <IconClipList size={18} />
        </span>
        <div className="lp-dash-opp-body">
          <div className="lp-dash-opp-title">Kategori · İlçe</div>
          <div className="lp-dash-opp-meta">
            <span>Kalite skoru · bütçe aralığı · aciliyet</span>
          </div>
        </div>
        <div className="lp-dash-opp-cost">
          <span className="lp-dash-opp-cost-label">kredi bedeli talep detayında</span>
        </div>
      </div>

      <Link className="btn btn-primary btn-block" href="/providers/register">
        Hizmet veren ol
        <IconArrowRight />
      </Link>
    </div>
  );
}

const legacyPoints = [
  'Belirsiz müşteri niyeti',
  'Görülmeyen teklifler',
  'Takip edilmesi zor maliyet',
  'Kredi / bakiye nereye gitti belirsiz',
];

const takticPoints = [
  'Talep kalite skoru',
  'Görüntülenme takibi',
  'Kredi hareket geçmişi',
  'İade uygunluğu görünürlüğü',
  'Bölge / kategori eşleşmesi',
];

function Comparison() {
  return (
    <section className="lp-section lp-section-white">
      <div className="lp-container">
        <div className="lp-section-head">
          <div>
            <span className="lp-eyebrow">Karşılaştırma</span>
            <h2 className="lp-h2">Eski modelden daha şeffaf.</h2>
          </div>
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
              <span className="lp-comp-title lp-comp-title-primary">TakTick modeli</span>
              <span className="lp-badge lp-badge-primary">Şeffaf</span>
            </div>
            <div className="lp-comp-list">
              {takticPoints.map((t) => (
                <div key={t} className="lp-comp-item">
                  <span className="lp-comp-mark">
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

const ctaBullets = [
  'Kategori seç',
  'Hizmet bölgeni belirle',
  'Admin onayından sonra talepleri gör',
  'Krediyle teklif ver',
];

function ProviderCTABand() {
  return (
    <section className="lp-section lp-section-poster">
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
          <Link className="btn btn-lg lp-cta-band-btn" href="/providers/register">
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
    <section className="lp-section lp-section-white">
      <div className="lp-container">
        <div className="lp-section-head">
          <div>
            <span className="lp-eyebrow">Güven</span>
            <h2 className="lp-h2">Daha güvenli hizmet pazaryeri deneyimi</h2>
          </div>
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

        <div className="lp-final-cta">
          <h2 className="lp-h2">{heading}</h2>
          <p className="lp-final-cta-sub">
            Birkaç dakikada talebini gönder, gelen teklifleri karşılaştır.
          </p>
          <div className="lp-final-cta-buttons">
            {isAuthenticated ? (
              <Link className="btn btn-primary btn-lg" href="/categories">
                {isCustomer ? 'Yeni Talep Oluştur' : 'Hizmet Al'}
                <IconArrowRight />
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
      </div>
    </section>
  );
}
