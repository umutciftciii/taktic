# ADMIN-ACTIONS-001–007 — Talep ve teklif ekranlarındaki yeni işlevlerin envanteri

- **Tarih:** 2026-09-28
- **Taban:** `main@25e4ec4d` (ADMIN-DESIGN-001 Faz 3A dalı)
- **Bağlam:** ADMIN-DESIGN-001 planı, K11 kararı (2026-09-28). Faz 3A'da çalışan karşılığı olmayan eylem render edilmez. ADMIN-ACTIONS-001–007 ayrı ürün/backend/UI dilimlerinde teslim edilir.
- **Durum:** Yedi işlevin yedisi de **açık backlog kalemidir**. Hiçbiri iptal edilmedi, hiçbiri "yapılmayacak" diye kapatılmadı.
- **Kaynak:** API davranışları koddan okundu, çalıştırılarak denenmedi. Dosya:satır referansları bu tarihteki `main` içindir.

Numaralandırma, backlog'daki sırayı izler:

| Kod | Tasarımdaki düğme | Ekran |
| --- | --- | --- |
| ADMIN-ACTIONS-001 | "Süreyi 7 gün uzat" | `/requests/[id]` → Talep bilgileri → "Bu talebe ne olacak" |
| ADMIN-ACTIONS-002 | "Teklifi müşteriden kaldır" | `/offers/[id]` → Yapabileceğin işlemler |
| ADMIN-ACTIONS-003 | "Müşteriye hatırlatma gönder" | `/offers/[id]` → Yapabileceğin işlemler |
| ADMIN-ACTIONS-004 | "Hizmet vereni uyar" | `/offers/[id]` → Yapabileceğin işlemler |
| ADMIN-ACTIONS-005 | "Eşleşmeyi iptal et" | `/offers/[id]` → Yapabileceğin işlemler |
| ADMIN-ACTIONS-006 | "Excel'e aktar" | `/requests` başlığı (ve `list:matches`) |
| ADMIN-ACTIONS-007 | "Elle talep ekle" | `/requests` başlığı |

---

## 1. Ortak kurallar (her dilim için)

Bunlar ADMIN-DESIGN-001 planının §0 kurallarının devamıdır.

1. **Tek kaynak izin.** Her yeni uç, `AdminPermission` enum'una eklenen **kendi** iznini ister ve `route-permission-map.ts`'ye girer. `AdminPermission` bir Prisma enum'udur, yani yeni izin bir migration demektir. Ekran bu izni yalnız `requireAdmin(...).can()` ile okur.
2. **Önce API, sonra düğme.** Düğme, ucun merge edildiği PR'da ya da ondan sonra gelir. "Yakında" etiketi, devre dışı yer tutucu ya da sahte önizleme yoktur.
3. **Onay diyaloğu gerçeği söyler.** Geri alınamayan her eylem `ConfirmDialog` arkasındadır. Metin; kimin hangi e-postayı alacağını, hangi kredinin hareket edeceğini ve neyin geri alınamayacağını, ucun gerçek davranışından yazar. Faz 3A'daki "Talebi reddet", "Talebi kaldır" ve "Krediyi iade et" diyalogları örnek alınır.
4. **Denetim izi.** Her yazma, işlemi yapanı (`actorId`/`createdById`) ve gerekçeyi kalıcı kaydeder. Kayıt "Neler oldu" sekmesinde görünür.
5. **Bildirimler outbox üzerinden gider.** Tekrar gönderimi `dedupeKey` ile önlenir ve gönderim `NotificationLog`'a düşer.
6. **Test üçlüsü.**
   - API: izin, durum geçişi ve yarış testleri (vitest).
   - E2E: izinli ve izinsiz personel görünürlüğü, onay diyaloğu, veritabanı sonucu.
   - Metin değişikliği: ilgili seçiciler aynı PR'da güncellenir.

---

## 2. Envanter

### ADMIN-ACTIONS-001 — Talebin yayın süresini uzat ("7 gün uzat")

**Bugün var olan:**
- Talep kayıtlarında bitiş kolonu yok. Bitiş `approvedAt + REQUEST_EXPIRY_DAYS (14)` ile hesaplanır.
  - Sabitler: `apps/api/src/modules/request-lifecycle/request-lifecycle.constants.ts:20-33`.
  - EXPIRED yazan tek yer: `request-expiry.service.ts:116-122`. Aday sorgusu: `:164-171`.
- 7. gün hatırlatması (`request-expiring` şablonu) `request-reminder.service.ts:47-161`'dedir.
  - Yalnız hiç teklifi olmayan APPROVED talebe, `reminderSentAt` boşsa bir kez gider.
- Tek fiili geçici çözüm, APPROVED talebi `PATCH /service-requests/:id/status` ile yeniden APPROVED kaydetmektir. Bu `approvedAt`'ı yeniler, yani 14 günü **baştan** başlatır, uzatmaz. Yeni bir yayın e-postası da gitmez.
  - Ürün yolu olarak kullanılmamalıdır.

**Gereken izin:** yeni `REQUESTS_EXTEND_EXPIRY`.

**Veri etkisi:**
- İki seçenek var:
  - `ServiceRequest.expiresAt` kolonu (migration + backfill `approvedAt + 14 gün`).
  - `expiryExtendedDays` toplamı.
- Expiry ve reminder zamanlayıcılarının aday sorguları yeni kolona göre yeniden yazılır.
- Her uzatma bir denetim satırı olarak kaydedilir (kim, ne zaman, kaç gün, gerekçe).

**Bildirim etkisi:** Açık karar. Müşteriye "talebiniz X tarihine kadar yayında" e-postası gidecek mi? Hizmet verenlere bir şey söylenecek mi?

**Açık ürün kararları:**
- Uzatma hakkı: talep başına tek sefer mi, sınırsız mı, toplam üst sınır var mı?
- Süre sabit 7 gün mü, seçilebilir mi?
- Hangi durumlardan izin verilir? Önerilen: yalnız APPROVED. EXPIRED talebi geri açmak ayrı bir işlev olur.
- Hatırlatma saati uzatmayla kayar mı? `reminderSentAt` sıfırlanır mı?

**Görev tanımı:**
- API: migration + backfill, `POST /service-requests/:id/extend-expiry { days, reason }`, zamanlayıcı sorgularının `expiresAt`'a taşınması, denetim satırı.
- UI: "Bu talebe ne olacak" kartında düğme + onay diyaloğu. Diyalog yeni bitiş tarihini ve kaç kez uzatıldığını yazar. "Yayında kalan süre" ve "Süre bitişi (planlanan)" artık kolondan okunur.
- Test: API yarış testi (aynı anda iki uzatma), zamanlayıcının uzatılmış talebi kapatmadığı; E2E izin ve diyalog.

**Risk:** Orta. Zamanlayıcı sorgusu değişir; yanlış backfill canlı talepleri erken kapatabilir.

### ADMIN-ACTIONS-002 — Teklifi müşteriden kaldır

**Bugün var olan:**
- Gizleme bayrağı yok.
  - Müşteri listesi tüm teklifleri döner (`offers.service.ts:318-371`). Sayaç yalnız WITHDRAWN'u düşer (`service-requests.service.ts:1296`).
- CANCELLED'ı yalnız talep reddi zinciri yazar (`rejectRequestInTransaction`).
- Geri çekme yalnız hizmet verenin kendisine açıktır: `POST /providers/:providerId/offers/:offerId/withdraw`.
- Teklif statüleri: SUBMITTED, VIEWED, SHORTLISTED, ACCEPTED, REJECTED, WITHDRAWN, EXPIRED, CANCELLED.

**Gereken izin:** yeni `OFFERS_REMOVE`.

**Veri etkisi:**
- Tercih edilen: `CANCELLED` + yeni `OfferCancellationReason.ADMIN_REMOVED` ve `cancelledAt`. Alternatif: ayrı `hiddenFromCustomerAt`.
- Hangisi seçilirse seçilsin, müşteri teklif listesi, kabul ucu, sayaçlar ve mesajlaşma bu durumu tanımalıdır. Kabul edilemez olmalıdır.
- Kredi: iade edilecek mi (`OFFER_REFUND` + yeni ledger nedeni), edilmeyecek mi? Otomatik iade kuralı bu teklifi görmeli mi?

**Bildirim etkisi:**
- Hizmet verene yeni şablon (ör. `offer-removed-by-admin`), gerekçesiyle.
- Müşteriye bildirim: karar.

**Açık ürün kararları:**
- Gerekçe listesi: iletişim bilgisi paylaşımı, uygunsuz fiyat, yanlış talep, diğer.
- Kredi iadesi otomatik mi, operatör seçimi mi?
- Hangi durumlardan izin verilir? Önerilen: SUBMITTED, VIEWED, SHORTLISTED. ACCEPTED hiçbir zaman; o 005'in işidir.
- Hizmet veren aynı talebe yeniden teklif verebilir mi? Bugün `@@unique([providerId, requestId])` buna izin vermez.

**Görev tanımı:**
- API: migration (neden enum'u), `POST /offers/:id/remove { reason, note, refund }`, müşteri okumalarında filtre, şablon.
- UI: "Yapabileceğin işlemler" satırı + diyalog. Diyalog kimin hangi e-postayı alacağını ve kredinin ne olacağını yazar.
- Test: müşteri ekranında teklifin görünmemesi ve kabul edilememesi (E2E); iade ledger'ı; izinsiz personelde satırın yokluğu.

**Risk:** Orta-yüksek. Müşteri tarafındaki her teklif okuması etkilenir.

### ADMIN-ACTIONS-003 — Müşteriye hatırlatma gönder

**Bugün var olan:**
- Elle hatırlatma ucu yok.
- Teklif için müşteriye giden tek e-posta, teklif geldiğinde bir kez giden `offer-received` (dedupe `offer-received:<offerId>`, `transactional-mail.service.ts:280-286`).
- Zamanlanmış 7. gün hatırlatması (`request-expiring`) **teklifsiz** talebe gider. Bu işlevin tersidir.
- `NOTIFICATION_RETRY` yalnız başarısız bir kaydı yeniden gönderir, yeni bir hatırlatma değildir.

**Gereken izin:** yeni `REQUESTS_REMIND_CUSTOMER`. Hatırlatma talep düzeyindedir: "teklifleriniz sizi bekliyor".

**Veri etkisi:**
- Yeni kolon gerekmez; hız sınırı `NotificationLog` üzerinden okunur (son gönderim).
- Açık karar: sayaç için `ServiceRequest.lastManualReminderAt` tutulacak mı?

**Bildirim etkisi:**
- Yeni şablon (ör. `offers-waiting-reminder`): müşteriye, talebin teklif sayfası bağlantısıyla.
- Tasarımdaki "24 saatte bir" kuralı dedupe anahtarına (`offers-waiting:<requestId>:<gün>`) ya da açık bir kontrole bağlanır.

**Açık ürün kararları:**
- Hatırlatma teklif başına mı, talep başına mı? Tasarım satırı teklif ekranında, ama e-posta talebi anlatır. Önerilen: talep başına.
- Sıklık: 24 saatte bir mi? Toplam üst sınır var mı?
- SMS de gidecek mi?
- Müşterinin e-postası yoksa (misafir talep) ne olur?
- Zamanlanmış otomatik sürümü olacak mı?

**Görev tanımı:**
- API: `POST /service-requests/:id/remind-customer`, hız sınırı (409 `REMINDER_TOO_SOON`), şablon, dedupe.
- UI: teklif detayında ve talep detayında satır + diyalog ("müşteriye şu e-posta gider; 24 saat içinde ikinci kez gönderilemez"). Son gönderim "Neler oldu"da görünür.
- Test: ikinci gönderimin reddi, e-posta outbox kaydı, izin.

**Risk:** Düşük. Yalnız e-posta; veri değişmez.

### ADMIN-ACTIONS-004 — Hizmet vereni uyar

**Bugün var olan:**
- Uyarı modeli yok. Hizmet verende yalnız `moderationNote` ve `suspendedAt` var.
- Moderasyon ucu `PATCH /providers/:id/status` (`PROVIDERS_MODERATE`) olup `SUSPENDED` yazabilir.
- Not altyapısı yalnız müşteriler için var: `POST /customers/:id/notes` (`CUSTOMER_NOTES_WRITE`).

**Gereken izin:** yeni `PROVIDER_WARNINGS_WRITE`. Okuma için `PROVIDER_WARNINGS_READ`, ya da `PROVIDERS_READ_DETAIL` yeterli mi (karar).

**Veri etkisi:**
- Yeni `ProviderWarning` modeli: `providerId`, `offerId?`, `requestId?`, `reason`, `note`, `createdById`, `createdAt`, `revokedAt?`.
- Tasarımdaki "üç uyarıda iş alma otomatik durur" kuralı, `SUSPENDED` yazan bir zincir demektir. Mevcut moderasyon akışıyla aynı yan etkileri taşımalıdır.

**Bildirim etkisi:**
- Hizmet verene uyarı e-postası: yeni şablon.
- Otomatik askıya almada ayrıca durum e-postası.

**Açık ürün kararları:**
- Otomatik askı gerçekten istenecek mi? Eşik 3 mü? Uyarıların süresi dolar mı (ör. 90 gün)?
- Uyarı geri alınabilir mi?
- Hizmet veren uyarıyı panelinde görür mü?
- Gerekçe listesi: fiyatı sonradan yükseltme, randevuya gitmeme, iletişim bilgisi paylaşımı…

**Görev tanımı:**
- API: migration, `POST /providers/:id/warnings`, `GET /providers/:id/warnings`, eşik zinciri (karara bağlı), şablon.
- UI:
  - Teklif detayında satır + diyalog. Diyalog mevcut uyarı sayısını ve eşiği aşarsa işletmenin askıya alınacağını yazar.
  - Hizmet veren detayında uyarı listesi (3B dilimiyle birlikte).
- Test: eşik zinciri yarış testi, izinler, E2E diyalog.

**Risk:** Orta. Otomatik askı canlı işletmeyi durdurur.

### ADMIN-ACTIONS-005 — Eşleşmeyi iptal et

**Bugün var olan:** Özellik olarak yok, bilinçli olarak engellenmiş (`offer-transitions.ts:79-81`). Mevcut yollar:

- **Talep yaşam döngüsü iptali** (`POST /service-requests/:id/cancel`):
  - Yalnız süper yönetici ya da müşteri kullanabilir.
  - Kabul edilmiş teklif ACCEPTED kalır.
  - Talep CANCELLED olur ve yeniden teklife **açılmaz**.
- **İstenmeyen yol:** `PATCH /offers/:id/status` ACCEPTED bir teklifi REJECTED ya da SHORTLISTED yapabilir.
  - Talep MATCHED kalır ve `matchedOfferId` artık kabul edilmemiş teklifi gösterir.
  - Faz 3A bu durumda onay diyaloğuyla uyarır, ama engellemez. Bkz. §3 F22.
- **İletişim paylaşımı:** `ContactRevealEvent` talep başına tektir (unique) ve kabul işleminin içinde yazılır. Açılmış iletişim bilgisi teknik olarak "geri kapatılamaz", çünkü iki taraf zaten gördü.

**Gereken izin:** yeni `MATCHES_CANCEL`. Yıkıcı ve geri alınamaz olduğu için rol tasarımında yalnız kıdemli personele verilmesi önerilir.

**Veri etkisi (çok parçalı):**
- **Talep:** MATCHED → APPROVED (yeniden teklife açılır) ya da CANCELLED. Karar. `matchedOfferId`/`matchedAt` temizlenir. Yayın süresi yeniden mi başlar?
- **Kabul edilen teklif:** yeni durum. Ör. `CANCELLED` + neden `MATCH_CANCELLED`. Kredisi iade edilir mi?
- **COMPETITOR_ACCEPTED ile reddedilen diğer teklifler:** geri açılır mı? Kredileri? Bugün kabul onlara iade yapmaz.
- **`ContactRevealEvent`:** silinmez (denetim). "İptal edildi" damgası eklenir mi?
- **Mesaj dizisi** (`MessageThread`, teklif başına): kapatılır mı, salt okunur mu olur?
- **Değerlendirme uygunluğu:** eşleşme iptal edilince müşteri değerlendirme yazamamalı.
- **Vitrin kaynaklı talepte** lead durumu.

**Bildirim etkisi:** müşteriye ve hizmet verene eşleşme iptali e-postaları (yeni şablonlar). Diğer hizmet verenlere "talep yeniden açıldı" gidecek mi?

**Açık ürün kararları:**
- Talep yeniden teklife mi açılır, kapanır mı?
- Kimin kredisi iade edilir?
- Hangi durumda kullanılır? Tasarım: "yalnızca dolandırıcılık şüphesinde veya iki taraf da isterse". Gerekçe zorunlu mu?
- Tamamlanmış (COMPLETED) talepte izin var mı? Önerilen: hayır.

**Görev tanımı:**
- API:
  - Tek serializable işlemde `POST /service-requests/:id/cancel-match { reason, note, reopen, refund }`.
  - Bu uç F22'yi de kapatır: `PATCH /offers/:id/status` ACCEPTED teklifte 409 döner.
- UI: teklif detayında yıkıcı satır + diyalog. Diyalog; talebin ne olacağını, kimin kredisinin iade edileceğini, iletişim bilgisinin zaten paylaşılmış olduğunu ve geri alınamazlığı yazar.
- Test: API yarış ve geri alma testleri, E2E tam akış (müşteri ve hizmet veren ekranları).

**Risk:** Yüksek. Eşleşme, iletişim paylaşımı, mesajlaşma ve değerlendirme zincirlerinin hepsine dokunur. Önce ayrı bir tasarım belgesi (spec) gerekir.

### ADMIN-ACTIONS-006 — Excel'e aktar

**Bugün var olan:**
- Hiçbir yerde CSV/XLSX üretimi yok (API, admin, web).
- Finans uçları yalnız JSON döner (`finance.controller.ts:16-37`).
- Liste verisi var:
  - `GET /service-requests` sayfalamasızdır; `/requests` filtreleri admin sunucusunda uygulanır.
  - `GET /offers?…` sunucu filtrelidir.

**Gereken izin:** yeni `REQUESTS_EXPORT` (ve teklifler için `OFFERS_EXPORT`). Okuma izni dışa aktarma izni sayılmamalıdır, çünkü dosya ekrandan çıkar ve denetimsiz dolaşır.

**Veri etkisi:**
- Kalıcı veri yok; her dışa aktarma bir denetim satırı yazar (kim, hangi filtre, kaç satır).
- **Kişisel veri:** listedeki müşteri telefon ve e-postası dosyaya girer. EB K6 (listelerde açık iletişim bilgisi) burada daha kritiktir: maskeleme mi, ayrı izin mi, kararı gerekir.

**Bildirim etkisi:** Yok.

**Açık ürün kararları:**
- Biçim: CSV (UTF-8 BOM, Excel uyumlu) mu, gerçek XLSX mi? XLSX bir bağımlılık kararıdır.
- Sütunlar: ekrandakiler mi, ek alanlar mı?
- Satır üst sınırı ve senkron/asenkron üretim.
- İletişim bilgisi dosyada açık mı?

**Görev tanımı:**
- API: `GET /service-requests/export?…` ve `GET /offers/export?…`, akış (stream) olarak, mevcut filtre sözlüğüyle; denetim satırı.
- UI: `/requests` ve `/offers` başlığında "Excel'e aktar" bağlantısı. Mevcut filtreler query olarak taşınır.
- Test: filtrenin dosyaya yansıması, izin yokken bağlantının yokluğu ve 403, Türkçe karakterlerin korunması.

**Risk:** Düşük (salt okuma). Kişisel veri riski orta: K6 kararına bağlı.

### ADMIN-ACTIONS-007 — Elle talep ekle

**Bugün var olan:** Admin'e özel uç yok. Herkese açık `POST /service-requests` (`service-requests.controller.ts:28-41`):
- Throttle, Turnstile ve isteğe bağlı oturum ister.
- SUPER_ADMIN çağırırsa iletişim bilgisini gövdede ister (`service-requests.service.ts:625-638`).
- `resolveCustomerForCreate` **her seferinde yeni müşteri** oluşturur. Telefon ya da e-posta başka hesaptaysa 409 `customerIdentityConflict` döner (`:1534-1576`), yani mevcut bir müşteriye talep bağlanamaz.
- Ardından aktivasyon bağlantısı ve alındı ya da yayın e-postası gider (`:527-574`).
- `CustomerOrigin.ADMIN_CREATED` enum'da var ama hiçbir yer yazmıyor; yalnız liste filtresi olarak görünüyor.

**Gereken izin:** yeni `REQUESTS_CREATE`.

**Veri etkisi:**
- Talep + gerekirse yeni müşteri (`origin: ADMIN_CREATED`) ya da mevcut müşteriye bağlama. Bağlama bir kimlik doğrulama kararıdır.
- Telefon doğrulaması: operatör telefonla konuşmuşsa "doğrulandı" sayılır mı? Önerilen: hayır. Kanıt yalnız OTP'dir; AUTH-PHONE-001 kuralları korunur.
- Kategori soruları ve kalite puanı aynı hesapla üretilir.

**Bildirim etkisi:** Müşteriye aktivasyon ve alındı e-postası (mevcut şablonlar). Otomatik yayın açıksa yayın e-postası ve eşleşen hizmet verenlere `request-available`.

**Açık ürün kararları:**
- Mevcut müşteriye bağlanabilir mi?
- Talep doğrudan yayına mı alınır, "Yeni talep" kuyruğuna mı düşer?
- Turnstile ve throttle admin ucunda nasıl ele alınır? Ayrı uç, ayrı guard.
- Telefon doğrulaması kanıtı nasıl alınır?

**Görev tanımı:**
- API: `POST /admin/service-requests` (admin guard + `REQUESTS_CREATE`, Turnstile yok), `origin: ADMIN_CREATED`, kimlik çakışması kuralları, denetim satırı.
- UI: `/requests/new` formu. Kategori soruları dinamik: web formunun alan bileşenleri paylaşılabilir mi, ayrı karar.
- Test: kimlik çakışması, izin, E2E form. StickyActionBar kullanılırsa Faz 3 kabul kriteri geçerlidir: gerçek Next router + server action entegrasyon E2E'si.

**Risk:** Yüksek. Kimlik ve hesap oluşturma kuralları (AUTH-REG-001, REQ-UX-010) ile kesişir.

---

## 3. Faz 3A sırasında bulunan ilgili API davranışları

Bu PR'da API'ye dokunulmadı. Aşağıdakiler ekranda doğru gösterildi, ama kökleri API'dedir ve ilgili ADMIN-ACTIONS dilimine ya da ayrı bir düzeltmeye bağlanmalıdır.

| # | Bulgu | Faz 3A'da ne yapıldı | Bağlandığı iş |
| --- | --- | --- | --- |
| F21 | `PATCH /offers/:id/status` iznin yanında `ensureCustomerCanAccessRequest` uygular (`offers.service.ts:794-810`). ADMIN rolündeki personel `OFFERS_STATUS` taşısa bile müşteri hesabına bağlı talepte 403 alır; bugün yeni taleplerin hepsi müşteri hesabına bağlanıyor | Durum işlemleri yalnız API'nin kabul edeceği yerde render edilir; yoksa ekran nedenini yazar | Ayrı karar: izin tek başına yetsin mi? (F5/F6 benzeri) |
| F22 | Reddet / kısa listeye al, ACCEPTED teklifte de çalışır; talep MATCHED kalır ve `matchedOfferId` kabul edilmemiş teklifi gösterir | İşlem korunur, ama onay diyaloğu tutarsızlığı açıkça yazar | ADMIN-ACTIONS-005 (ACCEPTED'da 409) |
| F23 | Admin kabulü iletişim paylaşımı onayını taşıyamaz. Paylaşım açıkken, talepte onay kayıtlı değilse kabul `CONTACT_DISCLOSURE_REQUIRED` ile reddedilir ve ekran genel hata sınırına düşer | Kabul diyaloğu bu koşulu yazar | Ayrı düzeltme: hata eşleme veya admin kabul kuralı |
| F24 | `PATCH /service-requests/:id/status` CANCELLED'ı teklif ve kredi zinciri olmadan yazar; APPROVED'a durum kontrolü yoktur. Örneğin kapanmış bir talep "Onayla" ile yeniden onaylanabilir | Davranış değişmedi; "Onayla" mevcut kuralla gösterilir | Ayrı düzeltme (durum makinesi) |
| F25 | İade taraması istemcisi API'yi tarayıcıdan, derleme anında gömülen adresle çağırıyordu. E2E'de (yerel + CI) erişilemez; 401/403'te ham gövde gösterir | Aynı uçlar ve gövdeyle admin sunucu aksiyonlarına taşındı (`app/refund-scan/actions.ts`) | Kapandı |
| F26 | İade taraması çalıştırma sonucu tablosu hiç görünmüyordu: sonuç yazıldıktan hemen sonra önizleme yenilemesi onu siliyordu | Düzeltildi: sonuç kalır, önizleme ayrıca yenilenir | Kapandı |

---

## 4. Önerilen uygulama sırası

Sıra; risk, bağımlılık ve kişisel veri kararlarına göredir. Her satır ayrı bir PR'dır.

1. **ADMIN-ACTIONS-003 Hatırlat.** Veri değişmez, tek şablon, hız sınırı. Talep ve teklif detayındaki "Yapabileceğin işlemler" kalıbının ilk gerçek ek satırı olur.
2. **ADMIN-ACTIONS-006 Excel'e aktar.** Salt okuma. **Ön koşul:** K6 (iletişim bilgisi) kararı.
3. **ADMIN-ACTIONS-001 Süre uzat.** Migration + zamanlayıcı sorgusu. Yayın süresi kolonu, 005'in "yeniden aç" seçeneği için de temel olur.
4. **ADMIN-ACTIONS-002 Teklifi kaldır.** Neden enum'u + müşteri okumaları. 005'in "diğer teklifler" kısmının deseni.
5. **ADMIN-ACTIONS-004 Uyar.** Yeni model; otomatik askı kararı gerekir. 3B (hizmet veren detayı) ile aynı döneme denk getirilmesi önerilir.
6. **ADMIN-ACTIONS-005 Eşleşmeyi iptal et.** **Ön koşul:** 001 ve 002'nin desenleri + ayrı spec. F22'yi de kapatır.
7. **ADMIN-ACTIONS-007 Elle talep ekle.** **Ön koşul:** kimlik ve hesap kararları (AUTH-REG, REQ-UX-010). En geniş kesişim.

Her dilim başlamadan önce ilgili "Açık ürün kararları" yanıtlanır. Yanıtsız karar varsa dilim başlamaz.
