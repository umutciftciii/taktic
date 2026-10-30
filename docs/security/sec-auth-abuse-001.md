# SEC-AUTH-ABUSE-001 — Kimlik uçlarında kötüye kullanım koruması

PRE-PAYMENT-READINESS-001 analizindeki **SEC-01** bulgusunun kapanışı.

## Ne değişti

| Uç | Önce | Şimdi |
|---|---|---|
| `POST /auth/login` (web **ve** admin) | Bellek-içi IP throttle (10/dk) | + Turnstile (`login`) + kalıcı deneme kapsamları (IP, IP+hesap, hesap) + tarafsız hata |
| `POST /auth/register-customer`, `register-provider` | IP throttle | + Turnstile (`register`) |
| `POST /auth/password-reset` (web **ve** admin) | IP throttle + hesap başı bütçe | + Turnstile (`password-reset`); başarılı `confirm` o e-postanın kilidini kaldırır |
| `POST /auth/email-verification/resend` | IP throttle + oturum | + Turnstile (`email-verification-resend`), oturumdan önce |
| `confirm` adımları (sıfırlama, e-posta doğrulama) | — | Değişmedi: e-postadaki tek kullanımlık bağlantı kanıttır |

Web ve admin **aynı** API uçlarını, **aynı** sunucu kurallarıyla kullanır;
CAPTCHA'sız alternatif uç yoktur. Tarayıcı tarafındaki kurallar (mod, site
key, test token'ı, ret metinleri) `packages/shared/src/turnstile-web.ts`
içinde tek yerdedir; iki uygulama aynı fonksiyonları okur
(`apps/admin/test/turnstile-sign-in.spec.tsx` bunu kimlik eşitliğiyle sabitler).

**Cloudflare Access** admin host'unun önünde olduğu gibi kalır. Turnstile onun
yerine geçmez; Access'ten geçmiş bir oturumda bile admin girişi ayrıca
Turnstile ister.

## Kalıcı deneme kapsamları

`AuthAttemptCounter` tablosu (migration `20261030090000_add_auth_attempt_counter`,
yalnız yeni tablo — mevcut satır, hesap, şifre veya oturuma dokunulmaz).
PostgreSQL'de tutulduğu için yeniden başlatmada kaybolmaz ve birden fazla API
örneğinde ortaktır. Anahtarlar SHA-256 özetidir; e-posta ya da IP açık
yazılmaz.

| Kapsam | Limit | Pencere | Kilit | Neyi durdurur |
|---|---|---|---|---|
| `IP` (adres) | 50 başarısız | 15 dk | 15 dk | Tek adresten çok hesaba deneme (credential stuffing) |
| `IP_ACCOUNT` (adres+e-posta) | 5 başarısız | 15 dk | 15 dk | Tek adresten tek hesaba tahmin; normal yazım hatası burada kalır |
| `ACCOUNT` (e-posta) | 10 başarısız | 15 dk | 15 dk | Çok adresten tek hesaba dağıtık tahmin |

Değerler bilinçli olarak **kodda** (env değil): bir değişkendeki yazım hatası
kilidi kapatamasın. Değiştirmek bir PR'dır.

Kurallar (`apps/api/src/modules/auth/login-attempts.service.ts`):

- Deneme **şifre kontrolünden önce** atomik bir upsert ile sayılır; aynı
  ifadede hem artırılır hem değerlendirilir. 30 eşzamanlı istekten tam 5'i
  bcrypt'e ulaşır (yarış testi).
- Kapsamlar `IP → IP_ACCOUNT → ACCOUNT` sırasıyla ve **ilk retten sonra durarak**
  harcanır: kilitli bir adres hiçbir hesabın sayacını artıramaz; tek adresten
  tek hesaba yüklenmek yalnız çifti kilitler, hesabı herkese kilitlemez.
- Kilitli kapsam tekrar denendikçe uzamaz.
- Doğru şifre: çift silinir ve çiftin hesaba/adrese eklediği denemeler geri
  alınır (kendi yazım hatanız sizi geniş kilitlere taşımaz); **başkalarının**
  başka adreslerden biriktirdiği sayaç silinmez.
- Bilinmeyen bir e-posta bilinen gibi sayılır ve kilitlenir; yanıt gövdesi
  birebir aynıdır. Hesap varlığı kilitten okunamaz.
- Veritabanı hatası girişi reddeder; kontrol sessizce atlanmaz.
- Bir gün dokunulmayan satırlar 200 talepte bir süpürülür.

## Tarafsız hatalar

| Durum | Yanıt |
|---|---|
| Yanlış şifre / bilinmeyen e-posta / şifresiz hesap | `401 INVALID_CREDENTIALS` "E-posta veya şifre hatalı." (aynı gövde) |
| Pasif hesap | Önce şifre kontrol edilir; yanlışsa yukarıdaki 401, doğruysa `403` — pasif olduğu artık şifreyi bilmeyene söylenmez |
| Kilit (her kapsam) | `429 AUTH_TEMPORARILY_LOCKED`, kapsam adı yok |
| Turnstile | `403 TURNSTILE_REQUIRED` / `403 TURNSTILE_FAILED` / `503 TURNSTILE_UNAVAILABLE` (fail-closed) |

Bilinmeyen e-posta da sabit bir bcrypt (maliyet 12) karşılaştırması öder;
yanıt süresi hesabın varlığını ele vermez. Şifre sıfırlama ekranı Turnstile ve
throttle retlerini gösterir (ikisi de adresten bağımsızdır); diğer her yanıt
yine "gönderildi"dir.

Bilinen artık risk: kayıt (`register-*`) çakışmada hâlâ "bu e-posta veya
telefon kayıtlı" der — kayıt akışının doğası. Turnstile + throttle ile
otomasyonu pahalılaştırıldı; tam kapatma (e-postayla bildirim) ayrı bir ürün
kararıdır.

## Turnstile token'ı ve tekrar kullanım

Formlar sabit URL'lere doğal HTML POST'u olarak kalır (deploy sırasında açık
form çalışmaya devam eder). Gönderimde istemci bileşeni tek seferlik token
alır, gizli `turnstileToken` alanına yazar ve formu gönderir; route handler
alanı `x-turnstile-token` başlığına taşır, gövdeye ya da URL'e koymaz.
"interaction-only" görünümde gerçek kullanıcı çoğunlukla hiçbir şey görmez;
yanlış şifre sonrası yeni deneme yeni (görünmez) token alır — CAPTCHA döngüsü
yoktur. Token API'nin replay önbelleğinde ilk görüldüğü anda sahiplenilir:
aynı token ikinci kez (eşzamanlı dahil) `TURNSTILE_FAILED` alır; Cloudflare
de `timeout-or-duplicate` ile reddeder.

## Env / compose etkisi

Yeni değişken adı **yok**. Mevcut değişkenler yeni servislere iletilir:

| Servis | Eklenen | Not |
|---|---|---|
| admin (prod) | `APP_ENVIRONMENT` (zorunlu), `TURNSTILE_MODE`, `TURNSTILE_SITE_KEY`, `WEB_TRUST_PROXY` | web'inkilerle aynı değerler |
| admin (dev) | `APP_ENVIRONMENT`, `TURNSTILE_MODE`, `TURNSTILE_SITE_KEY` | `docker-compose.local.yml` admin'e `APP_ENVIRONMENT=local` verir → test adaptörü |
| api | — | `TURNSTILE_EXPECTED_HOSTNAMES` **değeri** admin host'unu da içermeli |

## Deploy öncesi zorunlu manuel adımlar (staging, sonra production)

1. **Cloudflare dashboard → Turnstile → mevcut widget → Hostname Management:**
   admin host'unu (ör. `admin-staging.…`) ekleyin. Aynı site key iki host'ta
   kullanılır. (Ayrı widget istenirse admin'e ayrı site key verilebilir; o
   zaman secret farklı olacağından API tek secret okuduğu için **önerilmez**.)
2. Host `.env`: `TURNSTILE_EXPECTED_HOSTNAMES` = web ve admin host'ları,
   virgülle (`staging.example,admin-staging.example`).
3. Host `.env`: `TRUST_PROXY=1` ve `WEB_TRUST_PROXY=true` (yoksa ekleyin).
   Cloudflare Tunnel/edge'in `X-Forwarded-For` ilettiğini doğrulayın (aşağıdaki
   kabul adımı 4).
4. Cloudflare Access politikası değişmez.

## Preflight (deploy hiçbir şeyi durdurmadan önce)

`scripts/ops/runtime-contract.mjs` artık şunları **FAIL** sayar:

- `APP_ENVIRONMENT (admin)` hedef ortam değil
- `TURNSTILE_SITE_KEY (admin)` boş → "nobody could sign in to the admin panel"
- `TURNSTILE_EXPECTED_HOSTNAMES ∋ ADMIN_ORIGIN` / `∋ WEB_ORIGIN` — listede
  yoksa her giriş `HOSTNAME_MISMATCH` alırdı (çıktı değeri değil, adı yazar)
- `TURNSTILE_MODE (web|admin)` bypass
- `TRUST_PROXY (api)` boş, `WEB_TRUST_PROXY (web|admin)` ≠ `true` — yoksa
  bütün girişler web sunucusunun adresinden gelir ve tek bir adres kilidi
  herkesi (yöneticiler dahil) dışarıda bırakır

## Kabul (deploy sonrası)

1. `scripts/ops/smoke.sh --sha <sha>`: token'sız `POST /auth/login` →
   `403 TURNSTILE_REQUIRED`; web ve admin `/login` sayfası widget'ı
   `cloudflare` modunda render eder (`turnstile-unconfigured` yok).
2. Admin'e Cloudflare Access'ten geçip gerçek tarayıcıyla giriş yapın
   (görünmez widget, tek tık).
3. Web'de müşteri girişi + şifremi unuttum isteği.
4. Son girişin `Session.ipAddress` değeri operatörün gerçek genel IP'si olmalı,
   container ağı (`172.x`/`10.x`) değil — adres limitlerinin doğru kişiyi
   saydığının kanıtı.
5. Geri dönüş: önceki image'a rollback; migration yalnız tablo eklediği için
   eski kod tabloyu yok sayar (geri alınması gerekmez).

## Kilitlenen yönetici — break-glass

Kendi kendine: şifre sıfırlama bağlantısını tamamlamak o e-postanın hesap ve
çift kilitlerini kaldırır. Beklemek de yeter (15 dk).

Operatör (host'ta, salt-okunur önce):

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps -T \
  api node dist/scripts/clear-auth-lock.js inspect --email <adres>
docker compose -f docker-compose.prod.yml run --rm --no-deps -T \
  api node dist/scripts/clear-auth-lock.js clear --email <adres> --confirm-email <adres> --apply
```

Adres kilidi (`IP`) bu betikle kaldırılmaz; o hesaba ait değildir, 15 dakikada
kendiliğinden düşer. Turnstile'ın kendisi çalışmıyorsa (Cloudflare kesintisi)
giriş bilinçli olarak kapalı kalır (fail-closed); bypass modu deploy edilmiş
ortamda boot'ta reddedilir.

## Operasyonel etkiler

- Paylaşılan NAT arkasındaki ofis: 15 dakikada 50 **başarısız** denemeye kadar
  etkilenmez; başarılı girişler adres sayacını tüketmez.
- Bir saldırgan bir hesabı 15 dakikada 10 başarısız denemeyle kilitleyebilir
  (her denemede Turnstile çözerek). Kurban şifre sıfırlamayla kilidi kaldırır.
- Turnstile kesintisinde giriş/kayıt/sıfırlama 503 verir (fail-closed).
- Bellek-içi throttle (`AUTH_RATE_LIMIT_MAX` / `_WINDOW_SECONDS`, 10/60 sn)
  aynen yerinde; kalıcı kapsamlar onun üstüne eklenir.
