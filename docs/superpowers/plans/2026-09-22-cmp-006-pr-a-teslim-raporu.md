# CMP-006 PR-A — Teslim raporu (paket iade politikası çekirdeği + checkout sözleşme kabul kanıtı)

Tarih: 2026-09-22 · Branch: `claude/cmp-006-package-refund-terms-1fc629` · Taban: `origin/main` @ `0af98870` ·
Tasarım: [`2026-09-22-cmp-006-pr-a-package-refund-terms-design.md`](../specs/2026-09-22-cmp-006-pr-a-package-refund-terms-design.md) ·
Dry-run: [`2026-09-22-cmp-006-pr-a-migration-i-dryrun.txt`](2026-09-22-cmp-006-pr-a-migration-i-dryrun.txt)

**Kampanya motoru anahtarı okunmadı, yazılmadı, açılmadı. Gerçek `.env`, Lemon, staging/yerel checkout ve yerel
veri bu PR'da değişmedi. Release gate varsayılan kapalı; RG-1 ve RG-2 açık.**

## 1. Sayılarla

| Ölçüm | Değer |
| --- | --- |
| Migration | **I** `20260922210000_add_purchase_terms_acceptance` — 75.; yalnız ekleme, **DML yok** |
| Yeni tablo / enum | `PurchaseTermsAcceptance` / `SourceChannel` |
| Yeni kolon | `PackagePurchase.termsAcceptanceRequired` (false), `PackagePurchase.purchaseTermsAcceptanceId` (NULL) |
| CHECK / FK / tetikleyici | 9 CHECK · 1 ertelenmiş bileşik FK · 2 tetikleyici (depodaki ilk tetikleyiciler) |
| Yeni rota | 1: `GET /payments/purchase-terms` (AuthGuard; admin rotası değil, izin haritası değişmedi) |
| Yeni API testi | **68** (kapı/belge seti 21 · uygunluk 25 · kabul kanıtı + DB değişmezleri 22) |
| Tam API paketi | **157 dosya / 3427 test — hepsi geçti** |
| Yeni E2E | 3 senaryo × Chromium + WebKit = **6** (yeni `purchase-terms` runtime'ı: API :3271 + web :3270) |
| Tam E2E | Chromium **296/296**, WebKit **125/125** (yerel koşu) |
| typecheck / lint / build | temiz |

## 2. Görev tanımının maddeleri

| İstenen | Nerede / kanıt |
| --- | --- |
| Ayrı ad alanı, `refund-policy`/`OfferRefundSettlement`'a dokunma | `modules/package-refunds/*`, `modules/purchase-terms/*`; teklif kredisi iade dosyalarında sıfır değişiklik |
| 14 gün; 14 gün 1 sn sonrası red | `package-refund-eligibility.ts`; saf + DB testleri tam sınırda |
| `paidAt` sonrası herhangi bir teklif harcaması (ücretli/promo fark etmez) red | `CREDIT_SPENT_SINCE_PAYMENT`; önceki bakiyeden harcama ve eşit an testleri |
| Bağlı promo tüketimi red; kullanılmamış promo tek başına bozmaz | `LINKED_PROMO_CONSUMED`; başka satın almaya bağlı lot sayılmaz testi |
| Yalnız tavsiye; iade/Lemon/`order_refunded`/clawback yok | Servis salt-okur, rotası yok; "yazmaz" testi |
| Makine okunur kod + Türkçe açıklama; eşzamanlı/tekrar belirlenimci | `reasons[{code,blocking,explanation}]`, `blockingCodes`; tek SELECT; 8 paralel + tekrar eşitlik testi |
| `PurchaseTermsAcceptance` alanları, satın alma başına tek, yeniden bağlanamaz | Tasarım §3.2 G1–G8; `purchase-terms-acceptance.spec.ts` "database" bölümü |
| Yeni satın almada zorunluluk DB + işlem sınırında; eskiler dürüst NULL | CHECK + tetikleyici + `createProviderPurchase` içinde kapı; dry-run §6 |
| Sahte `createdAt` bypass'ı | Zaman eşikli CHECK **kullanılmadı** (tasarım §3.3); 2000/2099/varsayılan `createdAt` ile red testi + dry-run §11; `acceptedAt` tetikleyiciyle işlem saati |
| IP/UA sızmaz | Sekiz uç noktada canary taraması (checkout, sağlayıcı liste/detay, admin liste/detay, finans özeti, terms, krediler) |
| Hukuk yayın kapısı, varsayılan kapalı, fail-closed | `PURCHASE_TERMS_GATE`; bozuk/eksik/yalnız-link/sürümsüz set boot'u reddeder; onaysız set staging/prod'da boot'u reddeder |
| Onaysız metni "onaylanmış sözleşme" diye yayınlamama | Metin kapı kapalıyken hiç sunulmaz; açıkken TASLAK bandı; `/sozlesmeler/*` yayımlanmadı |
| Kapı kapalıyken checkout değişmez | Mevcut ödeme/checkout/webhook testleri değiştirilmeden geçti; yanıt şekli testi; E2E "gate closed" senaryosu |
| Migration dry-run, tam API, typecheck/lint/build, iki tarayıcı E2E | §1 ve dry-run dosyası |

## 3. Uygulama sırasında çıkan bulgular

**B1 — S0 D9'un zaman eşikli CHECK'i bu görev tanımıyla çelişiyordu.** Kapı varsayılan kapalıyken migration
sonrası doğan satın almalar kabulsüz olmak zorunda; migration anına sabit eşik onları reddederdi. Satır başı
`termsAcceptanceRequired` + biconditional CHECK + değişmezlik tetikleyicisi seçildi. Kalan açık (DB kapıyı bilmez)
tasarım §3.3'te dürüstçe yazılı.

**B2 — Yeniden kullanılabilir checkout kabul kuralını delebilirdi.** Kapıdan önce açılmış PENDING bir hosted
checkout, kapı açıldıktan sonra kabulsüz geri verilebilirdi. Kapı açıkken yeniden kullanım yalnız aynı sürümle
kabul edilmiş checkout'a daraltıldı (test var). Not: yeniden kullanılan checkout'ta ikinci istek için yeni kabul
satırı yazılmaz; aynı hesabın aynı sürüme ilk kabulü geçerlidir.

**B3 — Eski `POST /providers/:id/package-purchases` rotası ikinci bir `OFFER_PACKAGE` doğum yoluydu.** Kapı her
iki yolda da `createProviderPurchase` içinde uygulanır; kapı açıkken operatör 403 alır.

**B4 — Finans özeti ham satın alma satırı döndürüyor.** Yeni iki kolon orada da gizlendi. Mevcut `paymentReference`
görünürlüğü bu PR'ın kapsamı dışında; ayrı iş olarak işaretlendi.

**B5 — E2E tuzağı:** gizli `termsVersion` alanı istemci bileşeninde; kutunun işaretlenmesi yeniden çizim yapıp
DOM'a elle yazılmış değeri geri alır. Bayat sürüm senaryosu değeri işaretlemeden **sonra** yazar.

## 4. Davranış değişiklikleri (dikkat)

| Değişiklik | Kim etkilenir |
| --- | --- |
| Kapı kapalı: yok (yanıtlar bayt bayt aynı; iki yeni kolon projeksiyonlardan atılır) | — |
| Checkout DTO'ları `termsAccepted` (boolean) ve `termsVersion` (≤64) kabul eder; kapı kapalıyken yok sayılır | Bu alanları gönderen yeni istemciler (önceden `forbidNonWhitelisted` 400'dü) |
| Yeni env `PURCHASE_TERMS_GATE` (boş = kapalı); geçersiz değer / bozuk set boot'u reddeder | Tüm dağıtımlar; `docker-compose.yml` ve `.env.example` güncellendi |

## 5. Açık release kapıları

- **RG-1 — açık.** Hukuki metinler (mesafeli satış, ön bilgilendirme, iade politikası) ve anında ifa/cayma
  değerlendirmesi onaylanmadan kapı açılmaz; kod onaysız seti staging/production'da reddeder.
- **RG-2 — açık.** IP/UA saklama amacı, erişim yüzeyi, maskeleme ve retention önerisi tasarım §8'de; süre
  uydurulmadı, süpürücü yazılmadı. Karar gelmeden kapı üretimde açılmamalı.

## 6. Merge sonrası yerel eşitleme (CI 3/3 ve merge'den sonra)

Yerel DB **74 → 75** (Migration I, yalnız ekleme). `.env` değişikliği gerekmez (kapı boş = kapalı). Önce dump,
sonra `migrate deploy`, ardından api/web restart. Kapı yerelde **açılmaz**; açmak isteyen `APP_ENVIRONMENT=local`
+ `PURCHASE_TERMS_GATE=on` ile yalnız taslak metni görür.
