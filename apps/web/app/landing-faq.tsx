'use client';

import { useState } from 'react';
import { IconPlus } from './landing-icons';

const items = [
  {
    q: "TakTic'te teklif almak ücretli mi?",
    a:
      'Hayır. Müşteri olarak talep oluşturmak ve gelen teklifleri görüntülemek ücretsizdir. Kredi sistemi yalnızca hizmet verenlerin teklif vermesinde kullanılır.',
  },
  {
    q: 'Hizmet verenler nasıl teklif verir?',
    a:
      'Onaylı bir hizmet veren, kategori ve bölge eşleşmesinin sağlandığı talepleri panelinde görür ve teklif kredisi kullanarak teklif gönderir.',
  },
  {
    q: 'Talep kalite skoru nedir?',
    a:
      'Talebin ne kadar detaylı, doğrulanmış ve takip edilebilir olduğunu özetleyen bir puandır. Telefon doğrulaması, brief detayı, lokasyon ve zaman bilgisi gibi sinyaller hesaplamaya girer.',
  },
  {
    q: 'Teklif kredisi nedir?',
    a:
      'Hizmet verenlerin teklif gönderebilmek için kullandığı dijital bir birimdir. Her teklifin kredi maliyeti, talebin niteliğine göre önceden gösterilir.',
  },
  {
    q: 'Görülmeyen tekliflerde kredi iadesi nasıl işler?',
    a:
      'Müşteri tarafından makul süre içinde görüntülenmeyen veya geçersiz olduğu tespit edilen taleplerde, iade uygunluğu otomatik taranır ve uygun olan krediler hesabına geri yansır.',
  },
  {
    q: 'Hizmet veren başvurusu nasıl yapılır?',
    a:
      '"Hizmet Veren Ol" adımından başvuru formunu doldurursun. Kategori, hizmet bölgesi ve gerekli bilgiler iletildikten sonra admin ekibimiz başvurunu inceler.',
  },
];

export function LandingFAQ() {
  const [open, setOpen] = useState<number>(0);

  return (
    <section className="lp-section lp-section-white" id="lp-sss">
      <div className="lp-container">
        <div className="lp-section-head">
          <span className="lp-eyebrow">Sık sorulanlar</span>
          <h2 className="lp-h2">Sık sorulan sorular</h2>
        </div>

        <div className="lp-faq-list">
          {items.map((it, i) => {
            const isOpen = open === i;
            return (
              <div key={it.q} className={`lp-faq-item${isOpen ? ' is-open' : ''}`}>
                <button
                  type="button"
                  className="lp-faq-q"
                  onClick={() => setOpen(isOpen ? -1 : i)}
                  aria-expanded={isOpen}
                >
                  <span>{it.q}</span>
                  <span className="lp-faq-plus" aria-hidden="true">
                    <IconPlus size={14} />
                  </span>
                </button>
                <div className="lp-faq-a">
                  <div style={{ paddingTop: 4 }}>{it.a}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
