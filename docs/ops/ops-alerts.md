# Operasyon alarmları (OBS-ALERT-001, OBS-ALERT-002)

Başarısız ya da gecikmiş zamanlanmış işler ve başarısız e-posta gönderimleri için
otomatik alarm. Motor API sürecinin içinde çalışır, yalnız **dışarıya mesaj
gönderir**; Telegram'dan komut almaz, sistemde işlem yapmaz.

## Ne izlenir

| Kaynak | Alarm koşulu | Önem |
|---|---|---|
| Zamanlanmış iş (`SchedulerRun`) | Son çalışma FAILED (hata türü: `DATABASE_ERROR`, `APPLICATION_ERROR`, `PROCESS_INTERRUPTED`) | Para/kredi hareket ettiren iş (`entitlement-renewal`, `unviewed-offer-refund`) veya üst üste 3 hata → **KRİTİK**, diğerleri UYARI |
| Zamanlanmış iş | Zamanı geçtiği hâlde çalışmadı (`OVERDUE`, Sistem Sağlığı'nın kaçırılan tick kuralı) | 3+ kaçırılan tick → **KRİTİK**, 1–2 → UYARI |
| E-posta (`NotificationLog`) | FAILED kayıtlar, hata sınıfına göre | `TRANSPORT_UNAVAILABLE`, `EMAIL_BRANDING_INCOMPLETE`, `EMAIL_PUBLIC_URL_INVALID` veya 3+ tekrar → **KRİTİK**, diğerleri UYARI |

İzlenmeyenler: kapalı işler (alarm üretmez, açık alarmı "iş kapatıldı" diye
kapatır), ilk tick'i henüz gelmemiş işler, alıcıya özgü e-posta hataları
(`INVALID_RECIPIENT`, `RECIPIENT_RELEASED`) ve alarm motorunun kendi gönderimleri.

## Yaşam döngüsü

- **OPENED** — sorun ilk görüldüğünde, bir kez.
- **REMINDER** — sorun sürüyorsa ve son bildirimden sonra yeniden görüldüyse en
  fazla 6 saatte bir; önem UYARI → KRİTİK'e yükselirse hemen.
- **RESOLVED** — tek kez, yalnız daha önce bilgi alan kanallara:
  - iş: zamanında başarılı bir çalışma;
  - e-posta: **30 dakika yeni hata yok ve son hatadan sonra gerçekten gönderilmiş
    (SENT) bir e-posta var**. Sessizlik tek başına düzelme sayılmaz.
- Aynı işte farklı bir hata → eski alarm sessizce kapanır (`SUPERSEDED`), yeni
  alarm OPENED gönderir.
- Gönderilmeden düzelen bildirimler iptal edilir (`CANCELLED`); geç bir "yeni
  sorun" mesajı gitmez.

Her alarmın sabit, anlamsız bir olay kimliği vardır (`OPS-XXXXXXXXXX`); bütün
mesajlarda geçer.

## Kanallar

| Kanal | Ne gider | Env |
|---|---|---|
| E-posta | Tüm bildirimler, ayrıntılı | `OPS_ALERT_EMAIL` |
| Telegram | KRİTİK OPENED/REMINDER ve onların RESOLVED'ı | `OPS_ALERT_TELEGRAM_BOT_TOKEN` + `OPS_ALERT_TELEGRAM_CHAT_ID` (ikisi birlikte) |

- `APP_ENVIRONMENT=production`: en az bir kanal **zorunlu** (boot reddi,
  preflight FAIL). Staging: kanalsız boot eder, WARN.
- Yarım Telegram çifti veya biçim hatası her ortamda boot reddidir. Değerler
  hiçbir loga, hata mesajına ya da API yanıtına yazılmaz; token yalnız API
  container'ına iletilir (`compose-security` denetler).
- Opsiyonel: `OPS_ALERT_TELEGRAM_TIMEOUT_MS` (1000–30000, varsayılan 10000),
  `OPS_ALERT_CRON` (varsayılan `*/5 * * * *`).

### Telegram kurulumu

1. BotFather ile bir bot oluşturun, token'ı host `.env`'ine
   `OPS_ALERT_TELEGRAM_BOT_TOKEN` olarak yazın (repoya asla).
2. Botu operasyon grubuna ekleyin; grubun sohbet kimliğini (`-100…`) bir kez
   elle bulun ve `OPS_ALERT_TELEGRAM_CHAT_ID` olarak yazın. Uygulama
   `getUpdates` çağırmaz ve webhook kurmaz.
3. API'yi yeniden başlatın; preflight `OPS_ALERT_TELEGRAM PASS` göstermelidir.

## Teslimat, retry ve mükerrer gönderim

- Her bildirim × kanal ayrı bir `OpsAlertDelivery` satırıdır; retry kanal
  bazındadır. Bir kanalın düşmesi diğerini bekletmez.
- Claim: `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` + token; lease
  5 dakika. Sonuç yalnız claim'in sahibi tarafından yazılır.
- Retry: 5 dk, 15 dk, 30 dk, 60 dk; 5. denemeden sonra `ABANDONED`.
- **Timeout sonrası mükerrer:** e-posta aynı `Idempotency-Key` ile
  (`taktic-ops-alert-<deliveryId>`) yeniden sunulur, Resend tekrarı göndermez.
  Telegram'ın idempotency anahtarı yoktur: sağlayıcı mesajı kabul edip yanıt
  zaman aşımına uğrarsa aynı mesaj ikinci kez gelebilir. Mesaj metni ve olay
  kimliği aynıdır; yeni bir olay değildir.

## Döngü ve izolasyon garantileri

- Alarm e-postaları `NotificationDispatcher`'dan geçmez, `NotificationLog`'a
  yazılmaz; başarısızlıkları yalnız `OpsAlertDelivery`'de kalır ve motor bu
  tabloyu kaynak olarak okumaz.
- Motor kendisi için `SchedulerRun` satırı yazmaz. Kendi hatası log'a ve
  `OpsAlertEngineState`'e (yalnız hata türü) yazılır, alarm üretmez.
- Değerlendirme `pg_try_advisory_xact_lock` ile tek seferde tek süreçte koşar;
  açık bir sorun için en fazla bir OPEN alarm (kısmi benzersiz indeks).

## Admin ekranı

**Sistem sağlığı → Operasyon alarmları** (`OPERATIONS_SETTINGS_READ`):
motorun son başarılı değerlendirmesi ve gecikmesi, kanalların tanımlı olup
olmadığı, açık ve son 7 günde kapanan alarmlar, kanal bazında teslimat durumu.
E-posta kaynaklı alarmlar ayrıca `NOTIFICATION_LOGS_READ` ister. Ekranda işlem
düğmesi yoktur.

Motorun kendisi durursa alarm gönderemez; bu ekranda **Gecikmiş/Çalışmıyor**
görünür ve genel durumu en az Sorunlu yapar. Harici watchdog sonraki fazdadır.

## Yönetilen e-posta alıcıları (OBS-ALERT-002)

E-posta alıcıları admin panelinden de yönetilebilir: **Sistem sağlığı →
Operasyon alarmları → Bildirim Ayarları** (ekran PR-B ile gelir; API
`/ops-alerts/recipients` ve `/ops-alerts/routing`).

- **Yönlendirme modu:** `ENV_LEGACY` (varsayılan) yukarıdaki OBS-ALERT-001
  davranışıdır — e-posta yalnız `OPS_ALERT_EMAIL`'e gider, alıcı listesi
  bildirim almaz. `MANAGED` modunda her e-posta bildirimi, tercihi açık her
  ACTIVE alıcıya ayrı bir teslimat satırı olarak gider. Geçiş ve geri dönüş
  yalnız SUPER_ADMIN'in (`OPS_ALERT_ROUTING_MANAGE`), önizleme + sayıya bağlı
  onayla yaptığı işlemlerdir. Telegram iki modda da değişmez.
- **Alıcı:** etiket, maskeli adres ve üç tercih (Uyarı / Kritik / Düzelme;
  varsayılan Kritik + Düzelme). En fazla 10 canlı alıcı. Adres değiştirilemez;
  "adresi değiştir" yeni alıcı + eskisinin silinmesidir. Silme crypto-shred'dir
  (şifreli adres ve HMAC silinir). Düzelme yalnız o alarm için daha önce
  bilgilendirilmiş ve hâlâ ACTIVE alıcıya gider.
- **Teslimat bağı:** yönetilen satır `recipientId` ile bir alıcıya kalıcı
  bağlıdır; silinmiş/pasif/tercihi kapalı alıcıya bekleyen satır `CANCELLED`
  olur, adresi çözülemeyen satır `DECRYPT_FAILED` ile `ABANDONED` olur —
  hiçbiri başka bir adrese ya da `OPS_ALERT_EMAIL`'e düşmez. Bildirim içeriği
  kuyruğa girerken satıra donar (`noticeSnapshot`); retry aynı içerik ve aynı
  `Idempotency-Key` ile gider.
- **Gizlilik:** yanıtlarda adres maskelidir; tam adres ayrı yetki
  (`OPS_ALERT_RECIPIENTS_REVEAL`) + onay ister ve her gösterim audit'e yazılır.
  Loglarda alıcı adresi hiçbir biçimde yer almaz.
- **Son kanal koruması:** son kritik e-posta alıcısını silmek/pasifleştirmek
  ayrı bir onay ister; production'da Telegram yoksa son kritik alıcı
  kaldırılamaz (409).
- **Anahtarlar:** adres AES-256-GCM ile şifreli, kimlik HMAC-SHA256.
  Staging/production anahtarlar tanımlanmadan boot etmez. Üretme, yedekleme,
  geri yükleme, rotasyon, kayıp ve sızma: `docs/ops/ops-alert-recipient-keys.md`.

## Geri alma

**OBS-ALERT-002** (alıcı yönetimi) için: `scripts/ops/obs-alert-002-rollback.md`
— önce yönlendirmeyi panelden `ENV_LEGACY`'ye döndürmek (R0); kod geri
alınacaksa açık yönetilen teslimatlar sayı bazında raporlanır ve yalnız
operatörün onayladığı sayılarla iptal edilir (R2). Şema geri alınmaz.
R2, `deploy-runtime.md`'nin "eski API image'ını yeni şemada başlatma"
kuralından bilinçli bir sapmadır (elle container değişimi + operatörün açık
kararı) ve ürün sahibinin onayı beklenen **açık bir karardır**; tercih edilen
yollar fix-forward ve dump'tan dönüştür.

**OBS-ALERT-001** için (yalnız OBS-ALERT-002 migration'ı uygulanmamış bir
veritabanında): kod geri alındıktan sonra, API durdurulmuşken:

```
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/obs-alert-001-rollback.sql
```

Yalnız alarm geçmişi silinir; iş, kredi, iade ve bildirim kayıtlarına dokunulmaz.
