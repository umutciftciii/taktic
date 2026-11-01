# Operasyon alarmı alıcı anahtarları (OBS-ALERT-002)

Yönetilen alarm alıcılarının e-posta adresleri veritabanında **AES-256-GCM** ile
şifreli durur (AAD `ops-alert-recipient:<id>`); aynı adresin iki kez eklenmesini
engelleyen kimlik **HMAC-SHA256** ile tutulur. İki ayrı sır vardır ve ikisi de
yalnız API container'ına gider (`compose-security` denetler):

| Değişken | Biçim | Ne işe yarar |
|---|---|---|
| `OPS_ALERT_RECIPIENT_ENC_KEYS` | `v<n>:<32 baytın base64'ü>`, virgülle (keyring) | Adresi şifreler / çözer |
| `OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE` | `v<n>` (keyring'de olmalı) | Yeni ve yeniden şifrelenen adreslerin anahtarı |
| `OPS_ALERT_RECIPIENT_HMAC_KEY` | ≥ 32 karakter | Adres kimliği (tekilleştirme, env adresi eşleşmesi) |
| `OPS_ALERT_RECIPIENT_HMAC_KEY_VERSION` | 1–1000, varsayılan 1 | Her HMAC'ın yanına yazılan sürüm |

Anahtar kaybı **geri alınamaz**: şifreli adres anahtarsız çözülemez. Yönetilen
mod dışında (Telegram, `OPS_ALERT_EMAIL`) hiçbir kanal bu anahtarlara bağlı
değildir; anahtar kaybı alarm sistemini susturmaz, yalnız yönetilen alıcıların
yeniden eklenmesini gerektirir.

Geri alma prosedürü ayrıdır: `scripts/ops/obs-alert-002-rollback.md`.

## Kurallar (her adımda)

- Bir anahtar **asla** ekrana, kabuk geçmişine, loga, ticket'a, sohbete veya
  repoya düşmez. `echo $KEY`, `cat .env`, değer gösteren `grep`, `env`,
  `docker inspect`, `docker compose config` kullanılmaz. Varlık kontrolü yalnız
  sayıyla yapılır (`grep -c`), keyring kontrolü yalnız id'lerle (aşağıdaki `awk`).
- Komutlar değeri kabuk değişkeninde taşır; `printf` kabuğun yerleşik komutu
  olduğu için değer süreç listesine de girmez. Değişken iş bitince `unset`.
- Anahtar **önce yedeklenir, sonra** `.env`'e yazılır. Yedeği alınmamış bir
  anahtarla tek bir alıcı bile şifrelenmez.
- Uygulama sırları adla anar, değeri asla: boot reddi ve preflight çıktısı
  güvenle okunabilir.

## Boot kuralı (deploy ön koşulu)

`APP_ENVIRONMENT=staging`, `production` veya **tanımsız** ortamda API,
`OPS_ALERT_RECIPIENT_ENC_KEYS`, `OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE` ve
`OPS_ALERT_RECIPIENT_HMAC_KEY` tanımlanmadan **boot etmez**; yayımlanmış
geliştirme anahtarlarını da reddeder (Task A2'nin bilinçli kararı,
`promotion-fingerprint` kalıbı). Bu yüzden OBS-ALERT-002'yi içeren ilk staging
deploy'undan **önce** aşağıdaki "İlk kurulum" bitmiş ve preflight'ta
`OPS_ALERT_RECIPIENT keys PASS` görülmüş olmalıdır. Yalnız `NODE_ENV=test` ve
`APP_ENVIRONMENT=local` değişken boşsa geliştirme anahtarlarını kullanır.

## İlk kurulum

### 1. Üret ve yedekle (operatörün makinesi)

```bash
umask 077
ENC_KEY="$(openssl rand -base64 32)"                 # 32 bayt, ekrana basılmaz
HMAC_KEY="$(openssl rand -base64 48 | tr -d '\n')"   # 64 karakter
```

Yedek iki yere, **veritabanı dökümlerinden ayrı**:

1. **Parola yöneticisi:** iki ayrı kayıt — `TakTic <ortam> OPS_ALERT_RECIPIENT_ENC v1`
   ve `TakTic <ortam> OPS_ALERT_RECIPIENT_HMAC v1`. Değeri panoya alıp kayda
   yapıştırın, sonra panoyu temizleyin:

   ```bash
   printf '%s' "$ENC_KEY" | pbcopy    # kayda yapıştır
   printf '%s' "$HMAC_KEY" | pbcopy   # ikinci kayda yapıştır
   pbcopy < /dev/null                 # panoyu boşalt
   ```

2. **Çevrimdışı şifreli kopya** (gpg parolayı kendisi sorar; parola da parola
   yöneticisinde, ayrı kayıtta):

   ```bash
   { printf 'OPS_ALERT_RECIPIENT_ENC_KEYS=v1:%s\n' "$ENC_KEY"
     printf 'OPS_ALERT_RECIPIENT_HMAC_KEY=%s\n' "$HMAC_KEY"
     printf 'OPS_ALERT_RECIPIENT_HMAC_KEY_VERSION=1\n'
   } | gpg --symmetric --cipher-algo AES256 -o ops-alert-recipient-keys-<ortam>-v1.gpg
   unset ENC_KEY HMAC_KEY
   ```

   Dosyayı çevrimdışı ortama (şifreli USB / kasadaki disk) taşıyın.
   **Asla** `$TAKTIC_BACKUP_DIR` / `~/Backups/taktic` içine, bir DB dump'ının
   yanına ya da aynı yedekleme hedefine koymayın: dump'ı ele geçiren anahtarı da
   ele geçirmemelidir.

### 2. Host `.env`'e ekle (staging/production host'u)

Değeri parola yöneticisinden yapıştırırsınız; `read -rs` ekrana yazmaz,
geçmişe yazılmaz.

```bash
ENV_FILE=<host .env yolu>
grep -c '^OPS_ALERT_RECIPIENT_' "$ENV_FILE"   # 0 olmalı; değilse dur, mevcut kayıtları bozma
read -rs ENC_KEY   # yapıştır, Enter
read -rs HMAC_KEY  # yapıştır, Enter
{ printf 'OPS_ALERT_RECIPIENT_ENC_KEYS=v1:%s\n' "$ENC_KEY"
  printf 'OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE=v1\n'
  printf 'OPS_ALERT_RECIPIENT_HMAC_KEY=%s\n' "$HMAC_KEY"
  printf 'OPS_ALERT_RECIPIENT_HMAC_KEY_VERSION=1\n'
} >> "$ENV_FILE"
unset ENC_KEY HMAC_KEY
grep -c '^OPS_ALERT_RECIPIENT_' "$ENV_FILE"   # 4
```

### 3. Doğrula

Preflight (`scripts/ops/deploy-preflight.sh` ya da `deploy-staging.sh --check`)
şunu göstermelidir — yalnız sürüm ve sayı, değer yok:

```
OPS_ALERT_RECIPIENT keys  PASS  keyring v1 (1 key), hmac v1
```

Keyring'deki id'leri değersiz listelemek için (bu belgedeki tek okuma biçimi):

```bash
awk 'BEGIN { p = "OPS_ALERT_RECIPIENT_ENC_KEYS=" }
     index($0, p) == 1 { n = split(substr($0, length(p) + 1), e, ",");
                         for (i = 1; i <= n; i++) { sub(/:.*/, "", e[i]); print e[i] } }' "$ENV_FILE"
```

## Geri yükleme (DB dump'ından dönüş)

Dump alıcı tablosunu şifreli haliyle taşır; anahtarları **taşımaz**. Geri
yüklenen veritabanı ancak o anki keyring, dump'taki her anahtar id'sini
içeriyorsa okunur.

1. Dump'ı her zamanki gibi geri yükleyin (`docs/ops/deploy-runtime.md` §5).
2. API'yi açmadan, geri yüklenen veritabanında hangi id'lerin kullanıldığına
   bakın (yalnız sayı; `obs-alert-002-rollback-report.sql` aynı bilgiyi
   `live_recipients_by_key_id` / `live_recipients_by_hmac_version` satırlarında
   verir):

   ```sql
   SELECT "addressKeyId", "addressHmacVersion", count(*)
   FROM "OpsAlertRecipient" WHERE status <> 'DELETED'
   GROUP BY 1, 2 ORDER BY 1, 2;
   ```

   API açıksa aynı bilgi `GET /ops-alerts/routing` yanıtında `keyIds` ve
   `hmacVersions` alanlarındadır (Bildirim Ayarları ekranındaki sürüm dağılımı).
3. **Her `addressKeyId` keyring'de olmalı** (yukarıdaki `awk` id listesi).
   Eksik id varsa: o anahtarı parola yöneticisinden / çevrimdışı kopyadan
   keyring'e geri ekleyin ("Rotasyon" adım 1'deki `awk` ile), API'yi recreate
   edin. Anahtar bulunamıyorsa "Anahtar kaybı" bölümüne geçin.
4. `addressHmacVersion` şu anki `OPS_ALERT_RECIPIENT_HMAC_KEY_VERSION`'dan
   farklıysa ve o sürümün HMAC anahtarı elinizdeyse, sürümü ona göre ayarlamak
   yerine `rehash` çalıştırın (adresler çözüldüğü sürece yeni HMAC'ı hesaplar).
5. Eksik anahtarla açılan API çökmez: o anahtarla şifreli alıcıya gidecek her
   teslimat `DECRYPT_FAILED` ile `ABANDONED` olur, **başka bir adrese veya
   `OPS_ALERT_EMAIL`'e asla düşmez**; "Göster" ve test gönderimi de aynı kodla
   reddedilir.

## Rotasyon (planlı)

Rotasyon çevrimiçidir; her satır kendi kısa transaction'ında, alıcı kilidi
altında yeniden şifrelenir. Eşzamanlı bir düzenleme kazanır, o satır bir
sonraki çalıştırmaya kalır (`failed` sayısında görünür, satır bozulmaz).

> Rewrap ve rehash her alıcının `version` alanını artırır. O sırada açık olan
> bir alıcı düzenleme formu kaydederken **409 `VERSION_CONFLICT`** alır;
> sayfayı yenileyip yeniden kaydetmek yeterlidir. Rotasyonu bir düzenleme
> sürerken yapmayın.

### Şifreleme anahtarı (ENC)

1. Yeni anahtarı üretin ve **yedekleyin** (İlk kurulum §1, id `v2`).
2. Keyring'e ekleyin (eski anahtar kalır; değer argümana değil ortama girer):

   ```bash
   cp -p "$ENV_FILE" "$ENV_FILE.pre-rotation"   # aynı sırları taşır; adım 8'de imha
   read -rs NEW_ENC_KEY && export NEW_ENC_KEY
   awk 'index($0, "OPS_ALERT_RECIPIENT_ENC_KEYS=") == 1 { $0 = $0 ",v2:" ENVIRON["NEW_ENC_KEY"] } { print }' \
     "$ENV_FILE" > "$ENV_FILE.new" && mv "$ENV_FILE.new" "$ENV_FILE"
   unset NEW_ENC_KEY
   ```

3. Aktif yapın:

   ```bash
   awk -v id=v2 'index($0, "OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE=") == 1 { $0 = "OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE=" id } { print }' \
     "$ENV_FILE" > "$ENV_FILE.new" && mv "$ENV_FILE.new" "$ENV_FILE"
   ```

4. Preflight: `keyring v2 (2 keys)`. Yalnız API'yi recreate edin. Bundan sonra
   yeni alıcılar `v2` ile şifrelenir, eskiler `v1` ile okunmaya devam eder.
5. **Rewrap:** SUPER_ADMIN, Bildirim Ayarları → yönlendirme paneli → "Yeniden
   şifrele" (panel PR-B ile gelir; o zamana kadar API:
   `POST /ops-alerts/routing/rewrap`, `OPS_ALERT_ROUTING_MANAGE`, yalnız SUPER_ADMIN).
   Yanıt `{ rewrapped, failed }`; `failed > 0` ise nedeni giderip tekrar
   çalıştırın (idempotent: zaten `v2` olan satıra dokunmaz).
6. Doğrulayın: `GET /ops-alerts/routing` → `keyIds` **yalnız** `{ "v2": n }`.
   `v1` görünürken bir sonraki adıma geçmeyin.
7. Eski id'yi keyring'den çıkarın ve API'yi recreate edin:

   ```bash
   awk -v drop=v1 'BEGIN { p = "OPS_ALERT_RECIPIENT_ENC_KEYS=" }
        index($0, p) == 1 { n = split(substr($0, length(p) + 1), e, ","); out = "";
                            for (i = 1; i <= n; i++) if (index(e[i], drop ":") != 1) out = out (out == "" ? "" : ",") e[i];
                            $0 = p out } { print }' \
     "$ENV_FILE" > "$ENV_FILE.new" && mv "$ENV_FILE.new" "$ENV_FILE"
   ```

   Preflight: `keyring v2 (1 key)`.
8. `$ENV_FILE.pre-rotation` dosyasını silin. Eski anahtarın yedeğini, eski
   dump'lar geri yüklenebilir kaldıkça saklayın (o dump'lar `v1` ile
   şifrelidir); planlı rotasyonda imha edilmez, yalnız "eski" olarak işaretlenir.

### Kimlik anahtarı (HMAC)

HMAC anahtarı tek değerdir, keyring'i yoktur; geçiş sürüm numarasıyla yapılır.
`rehash` adresi **şifreleme anahtarıyla çözerek** yeni HMAC'ı hesaplar, eski
HMAC anahtarına ihtiyaç duymaz.

1. Yeni HMAC anahtarını üretin ve yedekleyin (kayıt adı `... HMAC v2`).
2. `.env`'de `OPS_ALERT_RECIPIENT_HMAC_KEY` değerini (`read -rs` + `ENVIRON`
   ile, yukarıdaki `awk` kalıbı: `$0 = "OPS_ALERT_RECIPIENT_HMAC_KEY=" ENVIRON["NEW_HMAC_KEY"]`)
   ve `OPS_ALERT_RECIPIENT_HMAC_KEY_VERSION`'ı `2` yapın; API'yi recreate edin.
3. **Hemen** `rehash` (`POST /ops-alerts/routing/rehash`) ve
   `hmacVersions` yalnız `{ "2": n }` olana kadar tekrarlayın. Arada alıcı
   eklemeyin ve geçiş/geri dönüş yapmayın: eski sürümlü satırlar tekilleştirme
   ve env adresi eşleşmesinde görünmez.

## Anahtar kaybı

Şifreleme anahtarının hem kendisi hem tüm yedekleri kayıpsa o anahtarla
şifreli adresler **geri gelmez**. Etki: yalnız o alıcılara giden e-posta
(`DECRYPT_FAILED` → `ABANDONED`); Telegram ve `ENV_LEGACY` yönlendirmesi
etkilenmez.

1. Yeni bir anahtar üretip yedekleyin, keyring'e ekleyip aktif yapın (Rotasyon
   1–4). Kayıp id keyring'de kalamaz (değeri yok); çıkarın.
2. Kurtarılamayan alıcıları listeleyin: Bildirim Ayarları'nda son hatası
   `DECRYPT_FAILED` olanlar; ya da `keyIds` içinde artık keyring'de olmayan id.
3. Her biri için: alıcıyı **silin** (soft delete + crypto-shred; adresi
   çözmeyi gerektirmez) ve adresi kurumsal kaynaktan (kişinin kendisi, ekip
   listesi) öğrenip **yeniden ekleyin**; ardından test gönderimi. Bu, son
   kritik alıcıysa önce yenisini ekleyin (production'da son kanal korunur).
4. Mod `MANAGED` iken hiçbir ACTIVE kritik alıcı kalmadıysa geçici olarak
   panelden geri dönüş (`ENV_LEGACY`) yapın; `OPS_ALERT_EMAIL` hâlâ tanımlıdır.

HMAC anahtarı kaybı yalnız kimliği etkiler (adresler okunabilir): yeni HMAC
anahtarı + sürüm artırımı + `rehash` (HMAC rotasyonu) yeterlidir.

## Anahtar sızması

Şifreleme anahtarı sızdıysa adresler okunabilir kabul edilir; HMAC anahtarı
sızdıysa adres tahminleri doğrulanabilir. İkisi aynı yerde durduğu için birinin
sızması çoğu zaman ikisinin de sızmasıdır: **ikisini birden** değiştirin.

1. ENC rotasyonu 1–6 (yeni `v<n+1>`, rewrap, `keyIds` yalnız yeni id).
2. HMAC rotasyonu (yeni anahtar, sürüm +1, rehash, `hmacVersions` yalnız yeni).
3. Sızan id'yi keyring'den çıkarın, API'yi recreate edin.
4. **Sızan anahtarın imhası:** parola yöneticisi kayıtları, çevrimdışı `.gpg`
   kopyası, `$ENV_FILE.pre-rotation` ve `.env`'in her eski kopyası silinir.
   Sızan anahtarla şifrelenmiş eski dump'lar da aynı sızıntıyı taşır: bu
   dump'ların hangilerinin tutulacağı ayrı ve açık bir karardır (tutulan dump
   artık anahtarsız açılamayacağı için alıcıları silinip yeniden eklenmeli).
5. Audit izi: `REWRAPPED` / `REHASHED` satırları yalnız `{ keyId }` /
   `{ hmacVersion }` taşır; olay kaydına zaman ve sayıları yazın, değeri değil.
