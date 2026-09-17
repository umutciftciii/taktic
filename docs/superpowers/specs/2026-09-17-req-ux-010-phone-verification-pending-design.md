# REQ-UX-010 — Telefon doğrulaması bekleyen talep: makbuz, CTA ve yaşam döngüsü dili

Tarih: 2026-09-17 · Öncülü: REQ-UX-009 raporu §7 ("AÇIK + doğrulanmamış telefon → ekran
'ön incelemeye gönderildi' der, doğrusu 'telefonunuzu doğrulayın'").

## Sorun

`REQUIRE_PHONE_VERIFICATION=true` iken doğrulanmamış telefonla oluşturulan normal talep
`SUBMITTED` kalır; otomatik yayın AÇIK ise `verifyCode` onu aynı işlemde yayınlar
(`PhoneVerificationService.verifyCode` → `publishRequestInTransaction`). Müşteri yüzeyleri
ise `SUBMITTED`'ı tek başına "ön inceleme" diye okur ve doğrulama kartı "şu anda zorunlu
değildir" der. Gerçek bekleyen işlem müşterinin kendi telefon doğrulamasıdır.

## Karar: sahibine özel, açık projeksiyon

`SUBMITTED` "doğrulama bekleniyor" anlamına gelmez (operatör kuyruğu, ayar geçişi vb. de
`SUBMITTED` üretir). Müşteri projeksiyonuna (`toCustomerServiceRequest`, yani yalnız
`GET /service-requests/my` ve `GET /service-requests/my/:id`) tek bir salt-okunur alan eklenir:

```
awaitingPhoneVerification: boolean
```

`true` ancak dört koşul birlikte sağlanınca: kapı açık (`isPhoneVerificationRequired()`),
`phoneVerifiedAt === null`, `status === SUBMITTED`, `directShowcaseProviderId === null`
(vitrin lead kendi kanıtıyla doğar, bu alan onu hiç işaretlemez). Otomatik yayın ayarından
bağımsızdır: kapı açıkken operatör de doğrulanmamış talebi onaylayamaz (`PHONE_NOT_VERIFIED`),
yani her iki modda da gerçekten beklenen şey doğrulamadır.

Sızıntı sınırı: admin `GET /service-requests/:id`, provider yüzeyleri, public teklif uçları ve
misafir makbuzu bu alanı **almaz**; mevcut 401/403/404 sözleşmeleri değişmez. Yeni endpoint yok.

Doğrulama sonrası ne olacağını web hesaplamaz: API kanonik akışı (`verifyCode` → auto AÇIK ise
publish, KAPALI ise operatör) belirler. Web yalnız cümleyi seçmek için mevcut, fail-closed
`GET /marketplace-publish-policy` okumasını kullanır (REQ-UX-008/009 ile aynı kaynak).

## Yüzeyler

| Yüzey | `awaitingPhoneVerification=true` | Diğer |
| --- | --- | --- |
| Başarı ekranı (oturumlu sahip) | `data-variant="verify"`, başlık **Telefonunuzu doğrulayın**; açıklama AÇIK: "doğruladığınızda bölgenizdeki uygun hizmet verenlere iletilir"; KAPALI: "doğruladığınızda ön incelemeye alınır"; birincil CTA **Telefonumu doğrula** → `/requests/:id/offers#telefon-dogrulama`; "ön inceleme"/"yayınlandı" iddiası yok (AÇIK) | değişmez (`published` / `review` / `targeted`) |
| Talep detayı özeti | "Talebiniz henüz hizmet verenlere iletilmedi; telefonunuzu doğrulayın…" | `SUBMITTED`: ön inceleme dili (mevcut "iletildi" cümlesi yalnız iletilmiş durumlar için kalır) |
| Doğrulama kartı | zorunlu kopya + `id="telefon-dogrulama"`; AÇIK/KAPALI'ya göre sonuç cümlesi; aynı gönder/doğrula formları | mevcut "zorunlu değildir" kopyası (kapı kapalıyken) |
| Zaman çizelgesi | adım 2 **Telefon doğrulama** (bekliyor); AÇIK'ta "Ön inceleme" adımı gösterilmez, KAPALI'da doğrulamadan sonra gelir | değişmez |
| Misafir makbuzu | değişmez — durum iddiası yok, id üzerinden doğrulama durumu sızmaz; aktivasyon `redirectTo` zaten `/requests/:id/offers`'a götürür, kart orada görünür | — |

Yeni doğrulama mekanizması yok; mevcut `POST …/phone-verification` (+Turnstile) ve
`…/verify` server action'ları kullanılır. Token/OTP URL, storage, SSR HTML veya log'a yazılmaz
(değişmeyen mevcut sözleşme).

## Test matrisi

API (`request-auto-publish.spec.ts`): (a) AÇIK + kapı kapalı → `APPROVED`, alan `false`;
(b) AÇIK + kapı açık + doğrulanmamış → `SUBMITTED`, `my/:id` alan `true`; (c) aynı talep
doğrulanınca → `APPROVED`, alan `false`, tek `request-available` + tek `request-published`,
ikinci verify 409 ve ikinci fanout yok; (d) KAPALI + doğrulanınca → `SUBMITTED`, alan `false`.
Sızıntı: anon 401, başka müşteri 404, provider 403, admin `GET /:id` alanı taşımaz.

Web (vitest, sunucu bileşeni render): başarı ekranı `verify` varyantı (AÇIK/KAPALI cümleleri),
`SUBMITTED`+`false` → `review`, misafir değişmez; kart kopyası zorunlu/zorunlu değil.

E2E (`phone-verification-gate.spec.ts`, `phoneGateRuntime` + `setAutoPublish(true)`): talep →
`verify` makbuzu → kart → kod (test SMS outbox) → doğrula → `Onaylandı`, kart yok, ikinci
tarayıcıdaki provider talebi görür; 320/768/1440'ta kart ve çizelgede taşma yok.

## Kapsam dışı

Prisma/migration, `.env`, compose, Turnstile/SMS yapılandırması, admin/provider ekranları,
vitrin lead, e-posta şablonları (zaten `nextStep: 'verify'` taşıyor), `/requests/my` panosu.
