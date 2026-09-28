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

> **Durum (2026-09-28, PR #118):** Eşleşmeyi talebi kapatarak sonlandırma artık var: yetkili operasyonun "İptal et" işlemi (`REQUESTS_CANCEL`). K1–K5 kararlaştırıldı; tam kapsam `2026-09-28-request-cancellation-contract.md` belgesinde.
>
> **K4 kesin kapsamı:**
> - Kazanamayan tekliflerden açık olanlar (SUBMITTED, VIEWED, SHORTLISTED) kapanır.
> - Reddedilmiş olanlar REJECTED kalır; ret gerekçesi fark etmez, elle ret dahil.
> - Bu tekliflerin harcanmış ve henüz iade edilmemiş tek seferlik kredisi iade edilir. Bu, kabul öncesi ve eşleşmiş talepte aynıdır ve kazanan kararından bağımsızdır.
> - WITHDRAWN ve EXPIRED kendi politikalarında kalır.
>
> Bu bölümün geri kalanı, talebi kapatmadan eşleşmeyi çözüp talebi yeniden açan ayrı bir özelliktir ve hâlâ açıktır.

**Bugün var olan:** Özellik olarak yok, bilinçli olarak engellenmiş (`offer-transitions.ts:79-81`). Mevcut yollar:

- **Talep yaşam döngüsü iptali** (`POST /service-requests/:id/cancel`):
  - Yalnız süper yönetici ya da müşteri kullanabilir.
  - Kabul edilmiş teklif ACCEPTED kalır.
  - Talep CANCELLED olur ve yeniden teklife **açılmaz**.
- **İstenmeyen yol:** `PATCH /offers/:id/status` ACCEPTED bir teklifi REJECTED ya da SHORTLISTED yapabilir.
  - Talep MATCHED kalır ve `matchedOfferId` artık kabul edilmemiş teklifi gösterir.
  - Faz 3A ekranı bu iki işlemi ACCEPTED teklifte sunmuyor (PR #118 inceleme düzeltmesi). API de artık reddediyor: 409 `OFFER_ACTION_NOT_ALLOWED` (API-GUARD-OFFER-001, PR #119). Bkz. §3 F22.
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
  - F22'nin koruyucu kuralı (ACCEPTED teklifte reddet/kısa listeye 409) API-GUARD-OFFER-001 olarak PR #119 ile uygulandı (§3.1). Eşleşmeyi değiştirmenin tek meşru yolu artık bu özellik olacak; bugün böyle bir yol yok.
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

> **Okuma notu (2026-09-28, main@4e1d1c98):** "Bulgu" sütunu, bulgunun ilk kaydedildiği andaki (`main@25e4ec4d`) API davranışıdır. F22 ve F24 için bu davranış **tarihsel kanıttır**, bugünkü açık risk değildir. Güncel durum "Bağlandığı iş" sütunundadır.

| # | Bulgu | Faz 3A'da ne yapıldı | Bağlandığı iş |
| --- | --- | --- | --- |
| F21 | `PATCH /offers/:id/status` iznin yanında `ensureCustomerCanAccessRequest` uygular (`offers.service.ts:794-810`). ADMIN rolündeki personel `OFFERS_STATUS` taşısa bile müşteri hesabına bağlı talepte 403 alır; bugün yeni taleplerin hepsi müşteri hesabına bağlanıyor | Durum işlemleri yalnız API'nin kabul edeceği yerde render edilir; yoksa ekran nedenini yazar | Ayrı karar: izin tek başına yetsin mi? (F5/F6 benzeri) |
| F22 | *(Tarihsel, main@25e4ec4d; PR #119 ile kapandı)* Reddet / kısa listeye al, ACCEPTED teklifte de çalışır; talep MATCHED kalır ve `matchedOfferId` kabul edilmemiş teklifi gösterir. Eşzamanlı kabul + reddet de aynı sonucu üretir (§3.1) | Ekran ACCEPTED ve REJECTED teklifte hiçbir durum işlemi sunmuyor; nedenini yazıyor. Sayfa açıkken durum değişirse API'nin 409'u işlem listesinin üstünde açıklanır | **Kapandı:** API-GUARD-OFFER-001 (PR #119, 409 `OFFER_ACTION_NOT_ALLOWED`) |
| F23 | Admin kabulü iletişim paylaşımı onayını taşıyamaz. Paylaşım açıkken, talepte onay kayıtlı değilse kabul `CONTACT_DISCLOSURE_REQUIRED` ile reddedilir ve ekran genel hata sınırına düşer | Kabul diyaloğu bu koşulu yazar; 409 artık işlem listesinin üstünde açıklanır (`?statusError=disclosureRequired`), genel hata sınırına düşmez | Hata eşleme kapandı. Açık ürün kararı: admin kabulü müşteri onayını taşıyabilsin mi |
| F24 | *(Tarihsel, main@25e4ec4d; PR #119/#120 ile kapandı)* `PATCH /service-requests/:id/status` IN_REVIEW ve APPROVED hedefinde kaynak durumu denetlemiyor; CANCELLED'ı teklif ve kredi zinciri olmadan yazıyor. Eşleşmiş, tamamlanmış, reddedilmiş, iptal edilmiş, süresi dolmuş ya da taslak talep yeniden onaylanabiliyor (§3.1) | Ekran "İncelemeye al / Onayla"yı yalnız SUBMITTED, IN_REVIEW, APPROVED'da sunuyor (`apps/admin/lib/request-moderation.ts`); dışında nedenini yazıyor. Sayfa açıkken durum değişirse 409 "Durum yönetimi" kartında açıklanır | **Kapandı:** API-GUARD-REQUEST-001 (PR #119, 409 `REQUEST_STATUS_TRANSITION_NOT_ALLOWED`) ve API-GUARD-REQUEST-002 (PR #120, CANCELLED/DRAFT/SUBMITTED hedefleri 409 `REQUEST_STATUS_NOT_MODERATION_TARGET`) |
| F25 | İade taraması istemcisi API'yi tarayıcıdan, derleme anında gömülen adresle çağırıyordu. E2E'de (yerel + CI) erişilemez; 401/403'te ham gövde gösterir | Aynı uçlar ve gövdeyle admin sunucu aksiyonlarına taşındı (`app/refund-scan/actions.ts`) | Kapandı |
| F26 | İade taraması çalıştırma sonucu tablosu hiç görünmüyordu: sonuç yazıldıktan hemen sonra önizleme yenilemesi onu siliyordu | Düzeltildi: sonuç kalır, önizleme ayrıca yenilenir | Kapandı |

---

### 3.1 Doğrudan API kanıtı ve ayrı backend işleri (PR #118 inceleme bulguları 1–2)

> **Durum (2026-09-28, main@4e1d1c98):** aşağıdaki iki öneri PR #119 (API-GUARD-OFFER-001 + API-GUARD-REQUEST-001) ve PR #120 (API-GUARD-REQUEST-002) ile uygulandı. Kod adları önerilenden farklıdır: `OFFER_ACTION_NOT_ALLOWED`, `REQUEST_STATUS_TRANSITION_NOT_ALLOWED`, `REQUEST_STATUS_NOT_MODERATION_TARGET`. Admin ekranları bu kodları işlem bağlamında açıklar (`apps/admin/lib/status-conflicts.ts`). Kanıt tablosu tarihsel kayıt olarak bırakıldı.

**Tarihsel kanıt (main@25e4ec4d, PR #119 öncesi).** Bu bölümün geri kalanı, Faz 3A inceleme düzeltmeleri yazıldığı sıradaki durumu anlatır: o an düzeltmeler yalnız arayüz korumasıydı ve aynı tutarsızlık doğrudan API isteğiyle yaratılabiliyordu. Bugün bu isteklerin hepsi 409 alıyor (yukarıdaki durum notu).

**Kanıt.** 2026-09-28'de, `main@25e4ec4d` API kodu üzerinde, API test altyapısında (`apps/api/test/harness`) geçici bir sonda koşuldu. Sonda repoya eklenmedi. Oturum SUPER_ADMIN, iletişim paylaşımı kapalı.

| İstek | Başlangıç | HTTP | Sonuç |
| --- | --- | --- | --- |
| `PATCH /offers/:id/status {REJECTED}` | Teklif ACCEPTED, talep MATCHED | 200 | Teklif REJECTED, talep MATCHED, `matchedOfferId` aynı teklif |
| `PATCH /offers/:id/status {SHORTLISTED}` | Aynı | 200 | Teklif SHORTLISTED, talep MATCHED, `matchedOfferId` aynı teklif |
| Aynı teklife eşzamanlı `{ACCEPTED}` + `{REJECTED}` (12 deneme) | Teklif SUBMITTED, talep APPROVED | İkisi de 200 | 2/12 denemede teklif REJECTED + talep MATCHED ona bağlı. Arayüzde düğme olmasa da yarış yolu açık |
| `PATCH /service-requests/:id/status {APPROVED}` | MATCHED | 200 | Talep APPROVED; `matchedOfferId` ve kabul edilen teklif duruyor; yayın bildirimleri (müşteri + eşleşen hizmet verenler) kuyruğa 3 kayıt |
| Aynı `{APPROVED}` | COMPLETED, CANCELLED, EXPIRED, REJECTED, DRAFT | 200 | Talep APPROVED, 14 günlük süre yeniden başlar, yayın bildirimleri kuyruğa girer. REJECTED'te kapatılan teklifler kapalı kalır |
| `PATCH /service-requests/:id/status {IN_REVIEW}` | MATCHED, COMPLETED, CANCELLED, EXPIRED, REJECTED, DRAFT | 200 | Talep IN_REVIEW; MATCHED/COMPLETED'ta `matchedOfferId` ve ACCEPTED teklif kalır |

**Kök neden (tarihsel, main@25e4ec4d):**
- Teklif: `OffersService.updateRequestOfferAction` (`offers.service.ts`) reddet/kısa listeyi `updateMany({ where: { status: { notIn: CUSTOMER_UNACTIONABLE_OFFER_STATUSES } } })` ile yazıyor. Bu küme yalnız WITHDRAWN, CANCELLED, EXPIRED'dir; ACCEPTED dahil değil. Kabul işlemi serializable, reddet değil. Aynı yol müşterinin kendi teklif işlemlerinde de kullanılıyor.
- Talep: `ServiceRequestsService.updateServiceRequestStatus` yalnız hedefi denetliyor (`nonModerationStatuses`: MATCHED, COMPLETED, EXPIRED). IN_REVIEW ve APPROVED için kaynak durum kuralı yok.

#### API-GUARD-OFFER-001 — Kabul edilmiş teklifin durumunu koru (öneriydi; PR #119 ile uygulandı)

- **Kapsam:**
  - `updateRequestOfferAction`'da REJECT ve SHORTLIST için `where.status` kümesine ACCEPTED eklenir. Koşullu güncelleme 0 satır bulursa mevcut `ConflictException` döner.
  - Okuma öncesi erken 409 ve makine kodu eklenir (ör. `OFFER_ALREADY_ACCEPTED`).
  - Hem admin ucunu (`PATCH /offers/:id/status`) hem müşteri ucunu kapsar.
- **Regresyon testleri (API vitest):**
  - ACCEPTED teklifte REJECT ve SHORTLIST → 409, veri değişmez.
  - Eşzamanlı ACCEPT + REJECT → sonuç her zaman tutarlıdır (ya ACCEPTED + MATCHED, ya REJECTED + APPROVED). `barrier` ile gerçek çakışma, en az 20 deneme.
  - `admin-offer-status.spec.ts` ve müşteri teklif uçları.
- **Migration:** gerekmez.
- **Kalan risk (düzeltmeye kadar; tarihsel, PR #119 ile kapandı):** doğrudan API çağrısı ve yarış, eşleşmesi bozuk talep üretebilir. Ekran bu iki işlemi sunmadığı için olağan kullanımda tetiklenmez. Mevcut tutarsız kayıtlar için ön kontrol sorgusu: `ServiceRequest.status = MATCHED` ve eşleşen teklif `status ≠ ACCEPTED`.
- **ADMIN-ACTIONS-005'ten ayrı:** bu bir koruyucu kural, ürün kararı beklemez. Eşleşmeyi iptal etmek ayrı özellik olarak kalır.

#### API-GUARD-REQUEST-001 — Moderasyon geçişlerine kaynak durum kuralı (öneriydi; PR #119 ile uygulandı, CANCELLED/DRAFT/SUBMITTED hedefleri PR #120 ile kapandı)

- **Kapsam:**
  - `updateServiceRequestStatus`'ta IN_REVIEW ve APPROVED yalnız SUBMITTED, IN_REVIEW, APPROVED'dan kabul edilir; diğerlerinden makine kodlu 409 (ör. `REQUEST_NOT_IN_MODERATION`).
  - Kontrol, transaction içindeki `current` okumasına da uygulanır; eşzamanlı kabul ile yarışmaz.
  - REJECTED'ten dönüş yalnız `POST /reopen` (REQUESTS_REOPEN) yolunda kalır.
  - Açık karar: CANCELLED hedefi bu uçta kalsın mı? (O gün teklif ve kredi zinciri olmadan yazıyordu. PR #120 ile kaldırıldı: moderasyon ucu CANCELLED'ı 409 ile reddediyor, iptalin tek kapısı `POST /:id/cancel`. O kapının teklif, kredi ve bildirim sonuçları PR #118 iptal sözleşmesiyle kararlaştırıldı.)
- **Regresyon testleri:**
  - Her kaynak × hedef matrisi (9 × 2).
  - Telefon kapısı ve yayın kuyruğu testleri (`request-publish-outbox`, `request-phone-verification-pending`).
  - Admin E2E'si zaten aynı kümeyi sunuyor (`admin-requests-offers.spec.ts`).
- **Migration:** gerekmez.
- **Kalan risk (düzeltmeye kadar; tarihsel, PR #119/#120 ile kapandı):** doğrudan istekle eşleşmiş ya da kapanmış talep yeniden yayına alınabilir ve müşteriye/hizmet verenlere yayın e-postası gider. Ekran bu geçişleri sunmuyor.

## 4. Önerilen uygulama sırası

Sıra; risk, bağımlılık ve kişisel veri kararlarına göredir. Her satır ayrı bir PR'dır.

1. **ADMIN-ACTIONS-003 Hatırlat.** Veri değişmez, tek şablon, hız sınırı. Talep ve teklif detayındaki "Yapabileceğin işlemler" kalıbının ilk gerçek ek satırı olur.
2. **ADMIN-ACTIONS-006 Excel'e aktar.** Salt okuma. **Ön koşul:** K6 (iletişim bilgisi) kararı.
3. **ADMIN-ACTIONS-001 Süre uzat.** Migration + zamanlayıcı sorgusu. Yayın süresi kolonu, 005'in "yeniden aç" seçeneği için de temel olur.
4. **ADMIN-ACTIONS-002 Teklifi kaldır.** Neden enum'u + müşteri okumaları. 005'in "diğer teklifler" kısmının deseni.
5. **ADMIN-ACTIONS-004 Uyar.** Yeni model; otomatik askı kararı gerekir. 3B (hizmet veren detayı) ile aynı döneme denk getirilmesi önerilir.
6. **ADMIN-ACTIONS-005 Eşleşmeyi çöz ve talebi yeniden aç.** Talebi kapatarak sonlandırma PR #118 ile teslim edildi (iptal sözleşmesi). Kalan kısım: talebi kapatmadan eşleşmeyi çözmek. **Ön koşul:** 001 ve 002'nin desenleri, ayrı spec.

API-GUARD-OFFER-001 ve API-GUARD-REQUEST-001/002 bu sıranın dışındaydı ve PR #119/#120 ile tamamlandı.
7. **ADMIN-ACTIONS-007 Elle talep ekle.** **Ön koşul:** kimlik ve hesap kararları (AUTH-REG, REQ-UX-010). En geniş kesişim.

Her dilim başlamadan önce ilgili "Açık ürün kararları" yanıtlanır. Yanıtsız karar varsa dilim başlamaz.
