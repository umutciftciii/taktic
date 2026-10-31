# Operasyon alarmları (OBS-ALERT-001)

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

## Geri alma

Kod geri alındıktan sonra, API durdurulmuşken:

```
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/obs-alert-001-rollback.sql
```

Yalnız alarm geçmişi silinir; iş, kredi, iade ve bildirim kayıtlarına dokunulmaz.
