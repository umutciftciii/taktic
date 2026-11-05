# CI-HARDEN-002 — WebKit flaky test analizi

Taban: `main@47377c81`. Shard planı, süre geçmişi, CI mimarisi, timeout ve retry değişmedi; sabit
bekleme eklenmedi. Uygulama kodu değişmedi.

| Test | Durum | Değişiklik |
| --- | --- | --- |
| `showcase-phone-bypass.spec.ts:54` | Mekanizma deneyle kanıtlandı, CI olayının trace'i yok | `fillLeadContact` hidrasyonu bekliyor |
| `admin-system-screens.spec.ts:462` | **Kök neden doğrulanmadı** | Yok, bilerek |

## 1. CI kanıtı

28 Ekim – 5 Kasım arasındaki 60 koşunun, deneme başına tüm E2E job'larının log'u tarandı (282 job, 151'i
WebKit). İki hata da birer kez görüldü ve ikisi de aynı koşuda:
`41529281196`, `e2e webkit (2/5)`, deneme 2 ve 3. İkisinde de yeniden deneme geçti.

Trace yok: `Upload failure artifacts` yalnız job düşünce çalışıyor, flaky bir test job'u düşürmüyor. Bu
koşunun yeniden denenmesi deneme 2'nin rapor artifact'ini de geride bırakmadı. Dolayısıyla CI olayının
kendisi hiçbir hata için doğrudan incelenemedi.

## 2. Shard ilişkisi

- İki spec eski tek WebKit job'unda 24 koşuda hatasız; yeni dağılımda 19 koşuda birer hata. Sayı nedensellik
  için fazla küçük.
- Bu 19 koşunun 3'ü aynı plan ve aynı shard'daki denemelerdir. Sonraki koşularda spec'ler 3/5 ve 5/5
  shard'larına da düştü, hata tekrarlanmadı.
- Önceki dosyalardan kalan durum için kanıt bulunamadı. Her iki akış da kendi fixture'ını yaratıyor, kendi
  context'inde koşuyor. Shard 2'nin tam listesi Linux WebKit'te iki kez koşuldu: iki hedef test de geçti.

**Varsayım:** Shard değişikliği olsa olsa zamanlamayı etkilemiştir. Doğrudan neden olduğuna dair kanıt yok.

## 3. `showcase-phone-bypass:54`

**Hata:** `settleIdentityGate` içinde `waitForResponse` 20 sn doldu; `POST /api/auth/request-identity-check`
hiç gelmedi. Düşen satır 122, yani ikinci aktörün akışı.

**Mekanizma:** `gotoWeb`, DOMContentLoaded'da dönüyor; form henüz hidrasyon görmemiş olabiliyor. O anda
yazılan değer React state'ine ulaşmıyor, blur işleyiciye ulaşmıyor ya da `check()` boş state yüzünden erken
dönüyor (`identity-check.ts`). Sonuç: POST yok.

**Ölçümler (Linux WebKit, `--cpus=2`, script'ler `page.route` ile geciktirildi):**

| Script gecikmesi | Bugünkü sıra: POST yok | Hidrasyon beklemesiyle: POST yok |
| --- | --- | --- |
| 0 ms | 0/10 | 0/10 |
| 50 ms | 9/10 | 0/10 |
| 100–1600 ms (5 kademe) | 50/50 | 0/50 |

Yayınlanan yardımcılarla, iki runtime'da ve 0–1600 ms gecikmelerde kapı 100/100 açıldı. Yalnız blur'u
hidrasyona kadar bekletmek yetmiyor: alanlar önceden dolduysa POST yine gitmiyor. Bu yüzden bekleme ilk
`fill`'den önce. Gecikme enjekte edilmeden yarış oluşmadı (Mac 60, Linux 80 tekrar).

**Doğrulanmayan:** CI olayında script'lerin gerçekten geciktiği. Ayrıca neden ilk aktörün değil de ikincinin
düştüğü bilinmiyor.

## 4. `admin-system-screens:462`

**Hata:** `hydrated()` içinde `locator.evaluate`: "Execution context was destroyed".

**Mesaj navigasyonu kanıtlamaz:** Playwright'ın WebKit katmanı, JavaScript hatası olmayan her protokol
hatasını bu cümleye çeviriyor (`wkExecutionContext.ts › rewriteError`).

| Hipotez | Deney | Sonuç |
| --- | --- | --- |
| Testin doğal akışında bir navigasyon | Gövde aynı sırayla, 226 tekrar | 0 hata |
| Yavaş hidrasyon pencereyi büyütüyor | 0–400 ms rastgele gecikme, 120 tekrar (119'unda `hydrated` birden çok denedi) | 0 hata |
| `goto`, eski belgedeki same-document olayıyla erken dönüyor | Enjeksiyon, 10 tekrar | 10'unda `goto` yeni belgede döndü: **elendi** |
| `/api/session` 401 → `SessionGuard` `location.replace` | 401 enjeksiyonu, 20 tekrar | 7'sinde aynı hata: **mümkün, ama gerçek bir 401 kaynağı bulunamadı** |

226 tekrarda beklenmeyen protokol hatası da görülmedi. CI'daki yaklaşık 1/43
oran bu ortamda geçerli olsaydı 226 tekrarda hiç hata görmeme olasılığı yaklaşık %0,5 olurdu; yani bu ortam
CI'daki koşulu üretmiyor.

**Neden düzeltme yok:** Kök neden bilinmiyor. `hydrated()`'ı bu hatayı yutacak şekilde değiştirmek bir retry
olur ve 401 hipotezi doğruysa gerçek bir oturum kaybını gizler.

**Tekrar görülürse gereken kanıt:** Flaky denemenin trace'i. Bu, flaky koşularda trace yüklemeyi gerektirir;
CI değişikliği olduğu için bu işin kapsamı dışında bırakıldı.

## 5. Tekrarlı ölçümler

Her satır ayrı `pnpm e2e` koşusudur: `--repeat-each` bu suite'te geçersizdir. Retry yerelde 0.

| Koşu | Tarayıcı | Tekrar | Sonuç |
| --- | --- | --- | --- |
| `showcase-phone-bypass` | Linux WebKit | 20 | 20 geçti |
| `showcase-phone-bypass` | Mac WebKit | 10 | 10 geçti |
| `showcase-placement-lead` (6 test) | Linux WebKit | 5 | 5 geçti |
| `admin-system-screens` (6 test) | Linux WebKit | 5 | 5 geçti |
| Üçü birlikte (13 test) | Chromium | 3 | 3 geçti |
| Shard 2 tam liste (46 test) | Linux WebKit | 2 | 4 ve 2 test düştü, bkz. §6 |

Linux WebKit: `mcr.microsoft.com/playwright:v1.62.1-noble`, `run-server` ile; uygulama sunucuları Mac'te,
trafik Playwright'ın loopback tüneliyle. CI'ın birebir kopyası değildir.

## 6. Açık riskler (bu PR'da düzeltilmedi)

1. **`loginToWeb`, `/login`'de kalma.** Shard 2'nin iki koşusunda 6 testte, her seferinde farklı testlerde
   görüldü. Bu testler `fillLeadContact` kullanmıyor. Hata anında e-posta alanı boş, şifre dolu; zorunlu alan
   gönderimi engellemiş olmalı. **Varsayım:** aynı hidrasyon sınıfı; tünelli ortam yarışı büyütüyor. CI'da 282
   job'da bir kez bile görülmedi.
2. **Hidrasyon öncesi yazılan değerler gerçek kullanıcı için de kaybolabilir.** Kontrollü alanlara yazılan değer
   state'e geçmiyor (deney A2) ve bağımsız incelemeye göre sonraki render'da DOM'dan siliniyor. Yavaş ağda
   gerçek kullanıcıyı etkileyebilir. Tarayıcıda yalnız ilk yarısı doğrulandı.
3. **Aynı yarış başka yardımcılarda açık:** `fillContactStep` / `completeContactStep` (kategori talep formu)
   ve `showcase-placement-lead.spec.ts` içinde `fillLeadContact`'ten önceki il seçimi (satır 628–631, 724–725).
4. **`page.goto: WebKit encountered an internal error`:** Aynı tarama döneminde 6 kez görüldü. Bu işin kapsamında değildi, incelenmedi.
