# REQ-UX-009 — Otomatik yayınla çelişen müşteri kopyaları: envanter ve düzeltme

Tarih: 2026-09-17 · Dal: `claude/auto-publish-copy-alignment-9bd419` · Taban: `origin/main` @ `1a5d3b5d`

## Amaç

`marketplaceAutoPublishEnabled=true` iken normal marketplace talep yolundaki müşteri yüzeylerinde
"ön inceleme" / "onay sonrası" dili kalmasın. Bu bir **kapsam denetimi**: önce müşteri normal
talep yolundaki her ilgili kopya envanterlenir, yalnız sözleşmeyle gerçekten çelişenler düzeltilir;
zaten doğru olanlar test ve bu notla kanıtlanır.

## Müşteri kopyası sözleşmesi (özet)

1. Normal talep · AÇIK · oturumlu sahip: yalnız API durumu `APPROVED` ise "Talebiniz yayınlandı";
   ön inceleme / onay sonrası ifadesi yok.
2. Normal talep · KAPALI · oturumlu sahip: talep gerçekten `SUBMITTED` ise ön inceleme dili.
3. Misafir makbuzu: durum iddiası yok; "Talebiniz alındı"; id üzerinden durum sızıntısı yok.
4. Form açıklayıcı metni: AÇIK → ön inceleme/onay ifadesi olmadan "uygun hizmet verenlere iletilir";
   KAPALI ya da ayar okunamadı → mevcut ön inceleme dili. `REQ-UX-008`'in okuma sözleşmesiyle aynı kaynak.
5. Vitrin/direct lead, admin, provider paneli, moderasyon, e-posta ve gerçek onay isteyen yüzeyler değişmez.

## Envanter (müşteri normal talep yolu ve komşuları)

| # | Dosya:satır (taban) | Kopya | Aktör / akış / durum | Sözleşme | Karar |
| --- | --- | --- | --- | --- | --- |
| 1 | `apps/web/app/categories/[slug]/page.tsx:109` | "Soruları yanıtla, talebin ön incelemeden geçtikten sonra bölgendeki onaylı ustalara iletilir." | Herkes (misafir + oturumlu) · normal form başlık altı · **yalnız kategori açıklaması boşken** · ayardan bağımsız sabit | #4 ile **çelişir** (AÇIK'ta ön inceleme vaat eder) | **Düzeltildi** — `requestFormIntroText(autoPublishEnabled)` |
| 2 | `apps/web/lib/request-next-steps.ts:13-15` | "Sırada ne var?" iki cümlesi | Herkes · normal form rayı · ayara göre | #4 uyumlu (REQ-UX-008) | Değişmedi |
| 3 | `apps/web/app/requests/success/page.tsx:128-135` | "Talep yayınlandı / Talebiniz yayınlandı / … şimdi görebilir ve teklif verebilir." | Oturumlu sahip · `status === 'APPROVED'` · `data-variant="published"` | #1 uyumlu | Değişmedi; unit + E2E ile kanıtlandı |
| 4 | `apps/web/app/requests/success/page.tsx:139-146` | "Talep alındı / Talebiniz ön incelemeye gönderildi / Onay sonrasında …" | Oturumlu sahip · `status !== 'APPROVED'` ve lead yok (pratikte `SUBMITTED`) · `data-variant="review"` | #2 uyumlu — **gerçek API durumundan** render edilir; ayar bayrağı okunmaz | Değişmedi; raporda "AÇIK'ta ön inceleme" diye görülen bu **kapalı-mod varyantıdır** (bkz. §Bulgu) |
| 5 | `apps/web/app/requests/success/page.tsx:78-95` | "Talep alındı / Talebiniz alındı / Talebiniz işleme alındı…" | Oturumsuz ziyaretçi · `data-variant="guest"` · API çağrısı yok | #3 uyumlu | Değişmedi; unit + E2E |
| 6 | `apps/web/app/requests/success/page.tsx:116-125` | "Talebiniz {işletme} işletmesine iletildi …" | Oturumlu sahip · aktif vitrin lead · `targeted` | #5 (vitrin) | Değişmedi |
| 7 | `apps/web/app/requests/[id]/offers/page.tsx:172` | Zaman çizelgesi adımı "Ön inceleme" (`done` = durum `SUBMITTED`/`IN_REVIEW` değilse) | Oturumlu sahip · talep detayı · gerçek durumdan | Durum göstergesi; AÇIK'ta doğan talepte adım "tamamlandı" görünür | Değişmedi (durum projeksiyonu, vaat değil) |
| 8 | `apps/web/app/requests/[id]/vitrin-karar/page.tsx:154` | "Talebiniz önce ekibimiz tarafından incelenir, sonra …" | Oturumlu sahip · vitrin lead fallback kararı (RELEASE) | #5 kapsam dışı (direct lead akışı) | Değişmedi |
| 9 | `apps/web/app/categories/[slug]/showcase-matches.tsx:144` | "… seçmezseniz bölgenizdeki tüm uygun hizmet verenlere …" | Herkes · vitrin eşleşme seçimi | Ön inceleme ifadesi yok | Değişmedi |
| 10 | `apps/web/lib/request-formatters.ts:4-5`, `lib/formatters.ts:15-16` | Durum etiketleri `IN_REVIEW: İncelemede`, `APPROVED: Onaylandı` | Oturumlu sahip · taleplerim / detay · gerçek durumdan | Durum etiketi | Değişmedi |
| 11 | `apps/web/app/page.tsx:456-463`, `landing-hero.tsx:326` | Landing "Admin ön inceleme … / Hizmet veren onay süreci" ve "Ön inceleme · Her talep" kartı | Herkes · pazarlama · statik | Talep yolu dışı; ayar okumuyor | Değişmedi — **açık risk** olarak raporda |
| 12 | `apps/web/app/providers/success/page.tsx:26`, `providers/register/page.tsx:27` | "Başvurunuz ön incelemeye gönderildi" / "Ön inceleme" | Hizmet veren başvurusu | Gerçek onay gerektirir (#5) | Değişmedi |
| 13 | `apps/web/app/requests/[id]/offers/offers-view.tsx:306` | "… karar … ekranda onaylanır." | Müşteri teklif kabulü | Talep yayınıyla ilgisiz | Değişmedi |

## Bulgu: başarı ekranı iddiası

`requests/success` yalnız `GET /service-requests/my/:id`'nin döndürdüğü `status`'a göre kelime seçer
(`page.tsx:110`). Otomatik yayın AÇIK'ken API talebi `APPROVED` doğurur
(`service-requests.service.ts:353-357`) ve ekran `published` varyantını gösterir; `review`
varyantı yalnız durum `APPROVED` değilse — yani anahtar KAPALI'yken (ya da aşağıdaki gate
istisnasında) — görünür. **Gerçek regresyon yok**; iddia kapalı-mod/nötr misafir varyantıdır.
Kanıt: `apps/web/test/request-success-screen.spec.ts` (gerçek `apiFetch` ile), E2E
`request-auto-publish` (`expectPublishedSuccess` artık "ön incele"/"onay" yokluğunu da doğrular),
`request-success-screen` (KAPALI `review`, misafir, başkası/yok → 404, vitrin `targeted`).

Tek istisna: `REQUIRE_PHONE_VERIFICATION=true` + AÇIK + doğrulanmamış telefon → talep `SUBMITTED`
doğar, `verifyCode`'da yayınlanır. Bu durumda ekran "ön incelemeye gönderildi" der; doğru mesaj
"telefonunuzu doğrulayın" olurdu. Sözleşme "API durumundan sapma yapma" dediği ve bayrak varsayılan
`false` olduğu için burada değiştirilmedi; açık risk olarak raporlandı.

## Değişiklik

- `apps/web/lib/request-next-steps.ts`: `requestFormIntroText(autoPublishEnabled)` —
  KAPALI: mevcut cümle aynen; AÇIK: `Soruları yanıtla, talebin bölgendeki uygun hizmet verenlere iletilir.`
- `apps/web/app/categories/[slug]/page.tsx`: boş açıklama fallback'i bu yardımcıdan gelir; aynı
  `getMarketplacePublishPolicy()` okuması (zaten `Promise.all` içinde) kullanılır; `<p>`'ye
  `data-testid="request-form-intro"`. Kategori açıklaması varsa her durumda o gösterilir.
- API'de değişiklik yok; `GET /marketplace-publish-policy` ve `GET /service-requests/my/:id`
  sözleşmeleri aynen. İkisi de `MarketplacePublishSettingsService.isAutoPublishEnabled()` /
  aynı yazma anındaki karardan beslenir; web ikisini birleştirmez.

## Fail-closed ve sızıntı

- Ayar okuma: `getMarketplacePublishPolicy` → HTTP ≠ 200, JSON olmayan gövde, yanlış şekil, ağ hatası
  → `false` → kapalı cümle (yeni unit `marketplace-publish-policy-read.spec.ts`, gerçek `apiFetch`).
- Başarı ekranı: oturumsuzda API çağrısı yok; rol ≠ CUSTOMER → 404; başkasının id'si → API 404 →
  `notFound()`; bozuk id → çağrısız 404. Yeni alan yok.

## Testler

- Web unit: `request-next-steps.spec.ts` (+2, RED→GREEN), `marketplace-publish-policy-read.spec.ts`
  (+9), `request-success-screen.spec.ts` (+10; karakterizasyon).
- API: `customer-request-detail.spec.ts` (+1; karakterizasyon — policy off→SUBMITTED, on→APPROVED,
  eski talep değişmez, yanıtta ayar alanı yok, yabancıya 404).
- E2E: `request-next-steps-note.spec.ts` (RED: `request-form-intro` yok → GREEN): açıklamasız
  kategori iki durumda 320/768/1440, açıklamalı kategori iki durumda kendi metni, form başlığında
  "ön incele"/"onay" yok, vitrin formunda iki cümle de yok; `journeys.expectPublishedSuccess`
  iddia-yok denetimi.
