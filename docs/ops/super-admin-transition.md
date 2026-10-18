# STG-003 — SUPER_ADMIN devri ve kurtarma

Süper yönetici yetkisini hedef adrese (ürün kararı: `umut.ciftci@icloud.com`)
taşımak için operatör adımları. Araç:
`apps/api/src/scripts/super-admin-transition.ts` (image içinde
`dist/scripts/super-admin-transition.js`).

> Bu PR hiçbir gerçek hesabın rolünü veya e-postasını değiştirmez. Aşağıdaki
> adımlar, onay verildikten sonra hedef ortamda (önce staging) operatör
> tarafından koşulur.

## Değişmez kurallar

- **Hiçbir aşamada son SUPER_ADMIN kaybolmaz.** Her yazım tek SERIALIZABLE
  transaction'dır; commit'ten önce "aktif + parolası olan en az bir
  SUPER_ADMIN" sayılır, yoksa tüm adım geri alınır. Yol A'da yeni süper
  yönetici giriş yapmadan eskisi emekliye ayrılamaz; iki hesap bir süre
  birlikte yetkilidir.
- **Sahipliği kanıtlanmamış adrese yetki verilmez.** Personel hesabı için
  kanıt, o adrese gönderilen "Şifremi unuttum" bağlantısını tamamlamaktır;
  tamamlanınca `User.emailVerifiedAt` yazılır (yalnız SUPER_ADMIN/ADMIN).
- **Müşteri/esnaf hesabı yöneticiye dönüştürülmez.** Hedef adres bir
  CUSTOMER/PROVIDER hesabındaysa araç reddeder; bir kişi karar verir (aşağıda).
- **Varsayılan kuru çalıştırmadır.** `--apply` olmadan her komut READ ONLY
  transaction'da okur, planı ve redleri basar, hiçbir şey yazmaz.
- **Parola yalnız terminalden, gizli prompt'la girilir.** `rename` ve
  `recover-password` yeni parolayı `/dev/tty` üzerinden, yankı kapalı (yıldız
  da yok) iki kez sorar; eşleşmezse veya kural dışıysa durur. Parola
  argümanla, ortam değişkeniyle, pipe ile veya log üzerinden verilemez:
  `SUPER_ADMIN_NEW_PASSWORD` / `SUPER_ADMIN_RECOVERY_PASSWORD` tanımlıysa
  (boş bile olsa) araç değeri basmadan reddeder. TTY yoksa
  (`docker compose run -T`, pipe, cron) veritabanına dokunmadan çıkar.
- **Çıktıda parola, hash veya token yoktur;** konsolda adresler maskelidir
  (`u***@icloud.com`). Geri alma için gereken tam adresler yalnız
  `--out` / `$TAKTIC_OPS_OUTPUT_DIR` / `~/Backups/taktic/ops` altındaki 0600
  manifest dosyasındadır — repoya girmez.
- **Oturumlar:** yetkisi veya adresi değişen her hesabın tüm oturumları, açık
  şifre sıfırlama ve doğrulama bağlantıları aynı transaction'da iptal edilir.
  Yol A'da hedefin oturumları `promote`'ta, eski yöneticininkiler `retire`'da;
  Yol B'de hesabın tüm oturumları `rename`'de kapanır.

## Ortak hazırlık

```bash
# Hedef ortamda, repo kökünde, KENDİ terminalinizde (ssh -t ile bağlıyken de
# olur). -T YOK: compose bir TTY ayırır, gizli prompt onu kullanır.
sat() {
  docker compose -f docker-compose.prod.yml run --rm --no-deps \
    -e TAKTIC_OPS_OUTPUT_DIR=/out -v "$HOME/Backups/taktic/ops:/out" \
    api node dist/scripts/super-admin-transition.js "$@"
}
```

Parola isteyen komutlar (`rename`, `recover-password`) çıktısı bir dosyaya
yönlendirilmiş veya `tee`'lenmiş olsa da prompt'u terminale yazar; değer hiçbir
yere yazılmaz. Bu komutları bir ajan/otomasyon üzerinden değil, kendi
terminalinizde koşun. Prompt görünmeden yazmaya başlamayın: program açılmadan
yazılan karakterleri terminal yankılar.

1. Yedek al: `scripts/ops/backup-db.sh` (geri dönüşün son çaresi).
2. E-posta teslimatının çalıştığını doğrula (Resend; staging'de
   `EMAIL_TRANSPORT=resend`). Sahiplik kanıtı bir e-postaya bağlıdır.
3. Durumu oku:

```bash
sat inspect --to umut.ciftci@icloud.com
```

Çıktı: tüm SUPER_ADMIN'ler (id, maskeli adres, aktiflik, adres kanıtı, parola
var/yok, son giriş, canlı oturum), hedef hesap ve ilişkileri, ve hangi yolun
uygulanacağı: `A-promote`, `A-retire`, `B-rename` veya `refused`.

## Yol A — hedef adreste bir personel (ADMIN) hesabı var

1. **Sahiplik kanıtı.** Hedef adresin sahibi web uygulamasında
   `/sifre-unuttum` sayfasından bağlantı ister ve tamamlar. `inspect`
   artık `emailVerified=true` gösterir. (Davet tamamlanmamışsa — parolası
   yoksa — önce davet bağlantısıyla parola belirlenir.)
2. **Terfi (kuru, sonra uygula):**

   ```bash
   sat promote --to umut.ciftci@icloud.com --confirm-to umut.ciftci@icloud.com
   sat promote --to umut.ciftci@icloud.com --confirm-to umut.ciftci@icloud.com --apply
   ```

   Hedef SUPER_ADMIN olur, oturumları kapanır. Eski süper yönetici
   dokunulmadan kalır. Manifest: `super-admin-transition-<zaman>-promote.json`.
3. **Yeni erişimi kullan.** Hedef hesapla admin paneline giriş yapılır.
4. **Eski yöneticiyi emekliye ayır:**

   ```bash
   sat retire --from-id <eski-id> --to umut.ciftci@icloud.com \
     --promotion-manifest /out/super-admin-transition-<zaman>-promote.json
   sat retire ... --apply
   ```

   Hedef, terfiden sonra (ve son 24 saat içinde) giriş yapmamışsa reddedilir.
   Eski hesap `ADMIN` + pasif olur, oturumları kapanır, `AccountStatusChange`
   satırı (aktör: yeni süper yönetici) yazılır.

Hedef zaten SUPER_ADMIN ise (`A-retire`) yalnız 3–4 uygulanır;
`--promotion-manifest` yoksa son 24 saatte giriş yapmış olması aranır.

## Yol B — hedef adreste hesap yok

1. **Yeni parolayı üret** — doğrudan parola yöneticisinde (ya da
   `openssl rand -base64 24` ile üretip hemen oraya kaydederek). Kabuk
   değişkenine, dosyaya veya komut satırına koymayın.

   En az 20 karakter, üç karakter sınıfı, tahmin edilebilir kelime yok.
   Uymazsa araç nedeni söyleyerek durur; değeri basmaz.
2. **Adres değişimi (kuru, sonra uygula).** Kuru çalıştırma da parolayı iki
   kez sorar ve kuralla doğrular (`password : typed twice, matches, passes
   the bootstrap rule`), hiçbir şey yazmaz:

   ```bash
   docker compose -f docker-compose.prod.yml run --rm --no-deps \
     -e TAKTIC_OPS_OUTPUT_DIR=/out -v "$HOME/Backups/taktic/ops:/out" \
     api node dist/scripts/super-admin-transition.js rename \
     --from-id <mevcut-süper-admin-id> \
     --to umut.ciftci@icloud.com --confirm-to umut.ciftci@icloud.com
   # aynı komut, sonuna --apply eklenerek
   ```

   Her iki çalıştırmada:

   ```text
   new super admin password (hidden, nothing is shown while you type):
   new super admin password again:
   ```

   Yazarken ekranda hiçbir şey görünmez; Enter ile bitirin. Backspace çalışır;
   ok/Escape/Tab tuşları girişi reddeder, Ctrl-C iptal eder (hiçbir şey
   değişmez).

   Tek transaction'da: adres hedefe geçer, `emailVerifiedAt` boşalır, parola
   yeni değere döner (eski — muhtemelen yayımlanmış — seed parolası artık
   çalışmaz), tüm oturumlar ve bağlantılar kapanır. Erişim kaybolmaz: yeni
   adres + yeni parola ile giriş yapılır. (`--keep-password` parolayı
   değiştirmez; yalnız mevcut parola zaten güçlü ve gizliyse kullanın.)
3. **Sahiplik kanıtı.** Yeni adresle `/sifre-unuttum` tamamlanır;
   `inspect` `emailVerified=true` gösterene kadar devir tamamlanmış sayılmaz.
   Kanıt gelmezse (adres yanlışsa) hemen geri alın.

## Hedef bir müşteri/esnaf hesabındaysa (`refused`)

Araç rol dönüştürmez: o hesabın talepleri, teklifleri, kredileri bir
pazar yeri hesabına aittir. Seçenekler bir kişinin kararıdır. Üründe
müşteri adresini değiştiren bir yol yoktur (profil formu e-postayı
reddeder).

- Hesap bir talep tarafından oluşturulmuş ve hiç sahiplenilmemişse
  (`AUTO_CREATED_REQUEST`, parolasız, kanıtsız): adres
  [customer-email-release.md](customer-email-release.md) ile serbest
  bırakılır, sonra Yol B.
- Hesabın bir sahibi varsa: sahibiyle görüşülür; araçla dokunulmaz.

## Geri alma

```bash
sat rollback --manifest /out/super-admin-transition-<zaman>-<eylem>.json
sat rollback --manifest ... --apply
```

| Manifest | Geri alma | Reddedildiği durum |
|---|---|---|
| `promote` | hedef tekrar `ADMIN` | başka kullanılabilir süper yönetici yoksa |
| `retire` | eski hesap tekrar aktif `SUPER_ADMIN` (+ durum satırı) | hesap artık pasif ADMIN değilse, parolası yoksa |
| `rename` | eski adres ve eski kanıt zamanı geri gelir | eski adres başka hesaba geçtiyse |
| `recover-password` | geri alınmaz | — |

Parola geri alınmaz: eski hash saklanmaz ve yayımlanmış bir parolayı geri
yüklemek yanlış olur. Her geri almada hesabın oturumları yeniden kapanır.

## Kurtarma prosedürü

**Panel girişi kayıp, e-posta çalışıyor:** `/sifre-unuttum` (her SUPER_ADMIN
için açık). Başarılı sıfırlama tüm oturumları kapatır.

**Parola bilinmiyor ve e-posta teslim edilemiyor** (veritabanı erişimi olan
operatör):

```bash
sat inspect --to umut.ciftci@icloud.com          # süper yönetici id'sini bul
sat recover-password --user-id <id>              # kuru: parolayı sorar, doğrular
sat recover-password --user-id <id> --apply      # parolayı sorar, uygular
```

Yalnız aktif bir SUPER_ADMIN için çalışır; parolayı ayarlar, oturumları ve
açık bağlantıları kapatır, manifest yazar (parola içermez).

**Tek süper yönetici yanlışlıkla emekliye ayrıldı:** `retire` manifestiyle
`rollback`. Araç, son kullanılabilir süper yöneticiyi bırakmayan bir adımı
zaten çalıştırmaz.

**Hepsi başarısız:** adım 1'deki yedekten `scripts/ops/restore-rehearsal.sh`
ile izole geri yükleme provası, sonra karar.

## Yerel geliştirme

`pnpm db:seed` yerel yöneticiyi (`admin@taktic.local`) yalnız yoksa ve
`SEED_SUPER_ADMIN_PASSWORD` güçlü bir değer taşıyorsa oluşturur; varsayılan
parola yoktur. Var olan hesabın parolasına, rolüne ve durumuna dokunmaz —
yeniden seed, emekliye ayrılmış bir hesabı tekrar terfi ettirmez.

## CI: sır taraması

`ops` job'unun ilk adımı `scripts/security/secret-scan.mjs`: izlenen her
dosyada bilinen başlangıç parolaları (yalnız sha256 listesi; dosya hiçbir
parolayı adıyla tutmaz), özel anahtar blokları, sağlayıcı token biçimleri,
literal sır atamaları ve uzun literal veritabanı parolaları. Bulgu dosya,
satır, kural ve kısaltılmış önizleme (`ilk 4 karakter… (uzunluk)`) basar;
değeri asla basmaz. Listeye ekleme komutu dosyanın başında.
