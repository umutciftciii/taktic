# REQ-UX-008 — “Sırada ne var?” metni otomatik yayın durumuna göre

Tarih: 2026-09-17 · Dal: `claude/request-form-autopublish-text-57dabc` · Taban: `origin/main` @ `a89699fa`

## Amaç

Normal marketplace talep formunun sağ rayındaki bilgi kutusu, `marketplaceAutoPublishEnabled`
ayarının o anki değerine göre doğru cümleyi göstersin. Yalnız bilgilendirme yüzeyi; talep
oluşturma API'sinin onay/yayın kararı değişmez.

## Metin sözleşmesi

- Başlık her durumda: **Sırada ne var?**
- KAPALI (ve her hata/eksiklik): `Talebiniz ön incelemeden geçtikten sonra bölgenizdeki onaylı hizmet verenlere iletilir ve 14 gün boyunca teklif alır.`
- AÇIK: `Talebiniz bölgenizdeki onaylı hizmet verenlere iletilir ve 14 gün boyunca teklif alır.`

## Okuma sözleşmesi

Mevcut public projeksiyon yok; admin ucu (`GET /operations-settings/marketplace-publish`)
SUPER_ADMIN'e kilitli ve değişiklik geçmişini taşıyor. `RefundPolicyController` örüntüsüyle
en dar public uç eklenir:

- `GET /marketplace-publish-policy` → `{ "autoPublishEnabled": boolean }`
- Kimlik doğrulaması yok, guard yok; tek boolean, başka alan yok.
- Değeri mevcut `MarketplacePublishSettingsService.isAutoPublishEnabled()` verir: satır yok → `false`,
  okunamadı → `false` (loglanır). Talep oluşturma yolunun okuduğu fonksiyonla aynıdır.

## Web

- `lib/api.ts`: `getMarketplacePublishPolicy()` → `apiFetch('/marketplace-publish-policy')`,
  `cache: 'no-store'` (mevcut `apiFetch` sözleşmesi). Yanıt `readMarketplacePublishPolicy(unknown)`
  ile katı okunur: yalnız `autoPublishEnabled === true` AÇIK; her başka biçim/hata/zaman aşımı → KAPALI.
- `app/categories/[slug]/page.tsx` (sunucu bileşeni, `cookies()` nedeniyle her istekte çalışır)
  değeri okur ve `RequestForm`'a `autoPublishEnabled: boolean` prop'u olarak verir.
- `app/categories/[slug]/next-steps-note.tsx`: `NextStepsNote({ autoPublishEnabled })` →
  `<div class="rail-note" data-testid="request-next-steps" data-auto-publish="on|off">`.
  Metin `lib/request-next-steps.ts` içinde saf fonksiyon (`nextStepsNoteText`).
- Fail-closed zinciri: API hata → `getMarketplacePublishPolicy` catch → `false`;
  bozuk gövde → `readMarketplacePublishPolicy` → `false`; prop verilmedi → `false` (varsayılan).

## Etkilenmeyen yüzeyler

Vitrin lead formu (`app/vitrin/[cardId]/lead-form.tsx`), başarı ekranı, landing, e-posta ve admin
kopyaları bu bileşeni içe aktarmaz. Kategori sayfası alt başlığındaki varsayılan açıklama
(`page.tsx`, kategori açıklaması boşken) kapsam dışıdır ve raporda açık risk olarak not edilir.

## Testler

- API: satır yok → false; false; true; yanıt yalnız `autoPublishEnabled` taşır; oturumsuz erişilir.
- Web unit: metin fonksiyonu (açık/kapalı), `readMarketplacePublishPolicy` (null, `{}`, string,
  1, `{autoPublishEnabled:true}`), `NextStepsNote` markup (başlık, tam cümle, testid).
- E2E: aynı kategori sayfası, ayar kapalı → kapalı cümle; fixture ile açık → yeni yüklemede açık
  cümle; 320/768/1440'ta kutu taşmıyor; aynı anda vitrin lead formunda bu testid/cümle yok;
  `afterEach` ayarı kapatır.
