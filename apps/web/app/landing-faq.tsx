import Link from 'next/link';
import { unviewedOfferRefundNotice } from '../lib/formatters';

/**
 * Built from the platform's current refund window rather than from a fixed
 * sentence: this answer is a commercial promise, and a page that keeps saying
 * 48 hours after an administrator sets 72 is making one the platform does not
 * keep.
 */
const buildItems = (refundWindowHours: number) => [
  {
    q: "TakTick'te teklif almak ücretli mi?",
    a:
      'Hayır. Müşteri olarak talep oluşturmak ve gelen teklifleri görüntülemek ücretsizdir. Kredi sistemi yalnızca hizmet verenlerin teklif vermesinde kullanılır.',
  },
  {
    q: 'Hizmet verenler nasıl teklif verir?',
    a:
      'Onaylı bir hizmet veren, kategori ve bölge eşleşmesinin sağlandığı talepleri panelinde görür ve teklif kredisi kullanarak teklif gönderir. Bir teklifin kredi bedeli talebin kategorisine göre değişir ve talep detayında yazılıdır.',
  },
  {
    q: 'Talep kalite skoru nedir?',
    a:
      'Talebin ne kadar detaylı ve takip edilebilir olduğunu özetleyen bir puandır. İletişim bilgisinin verilmiş olması, brief detayı, lokasyon ve zaman bilgisi gibi sinyaller hesaplamaya girer. Skor sunucu tarafında hesaplanır.',
  },
  {
    q: 'Teklif kredisi nedir?',
    a:
      'Hizmet verenlerin teklif gönderebilmek için kullandığı dijital bir birimdir. Her teklifin kredi maliyeti, talebin kategorisine göre önceden gösterilir.',
  },
  {
    q: 'Görülmeyen tekliflerde kredi iadesi nasıl işler?',
    a: `${unviewedOfferRefundNotice(refundWindowHours)} Teklif görüntülendiyse kredi iadesi yapılmaz.`,
  },
  {
    q: 'Hizmet veren başvurusu nasıl yapılır?',
    a:
      '"Hizmet Veren Ol" adımından başvuru formunu doldurursun. Kategori, hizmet bölgesi ve gerekli bilgiler iletildikten sonra ekibimiz başvurunu inceler.',
  },
];

/**
 * Native `<details>`: the accordion needs no client bundle, and it keeps
 * keyboard behaviour and the open/closed state the browser already gives.
 */
export function LandingFAQ({ refundWindowHours }: { refundWindowHours: number }) {
  const items = buildItems(refundWindowHours);

  return (
    <section className="lp-section" id="lp-sss">
      <div className="lp-container">
        <div className="lp-faq-grid">
          <div className="lp-faq-intro">
            <span className="lp-eyebrow">Sık sorulanlar</span>
            <h2 className="lp-h2">Sık sorulan sorular</h2>
            <p className="lp-section-sub">
              Aradığını bulamadıysan{' '}
              <Link href="/categories">kategorilerden</Link> devam edebilirsin.
            </p>
          </div>

          <div className="lp-faq-list">
            {items.map((it, index) => (
              <details className="lp-faq-item" key={it.q} open={index === 0}>
                <summary>
                  <span>{it.q}</span>
                </summary>
                <div className="lp-faq-a">{it.a}</div>
              </details>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
