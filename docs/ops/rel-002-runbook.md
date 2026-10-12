# REL-002 operasyon runbook'u (eşleşme turları, hizmet aksaklığı, MATCH_REVIEW kurtarma)

Bu belge REL-002'nin (Faz 1–5) staging/production'a çıkışını, özellik bayrağının
açılmasını, acil durumu ve MATCH_REVIEW'daki bir talebin kurtarılmasını anlatır.
Tasarımın ve her fazın gerçek sonucunun kaynağı
[`docs/superpowers/specs/REL-002-teknik-tasarim.md`](../superpowers/specs/REL-002-teknik-tasarim.md)
(§30–§34); deploy mekaniğinin kaynağı [`deploy-runtime.md`](deploy-runtime.md).

> Bu belgeyi yazan PR hiçbir staging/production ortamına dokunmadı ve
> `serviceIssueReportingEnabled` bayrağını açmadı. Aşağıdaki adımlar planlı bir
> pencerede, ayrı onayla uygulanır.

> **Release:** REL-002 **v0.2.0** ile çıkar (root `package.json` `0.2.0`,
> [CHANGELOG](../../CHANGELOG.md) `0.2.0` bölümü). Deploy edilen commit, `v0.2.0`
> tag'inin işaret ettiği merge commit'idir; tag ve GitHub Release
> [docs/release.md](../release.md) adımlarıyla merge sonrası atılır.

## 0. Neyin nesi

| Şey | Ne |
|---|---|
| Migration'lar | M1 `20261011120000_add_service_request_match_rounds`, M2 `20261011180000_enforce_round_matching_core`, M3 `20261012090000_add_service_issue_reopen_core`, M4 `20261012120000_add_incident_adjudication_reliability`, M5 `20261013090000_add_match_review_round_opening` — main'de toplam **99** |
| Bayrak | `OperationsSettings.serviceIssueReportingEnabled` — **varsayılan `false`**, admin „Operasyon ayarları" kartından (izin `SERVICE_ISSUE_SETTING_WRITE`, iki yönde onay diyaloğu) |
| Salt-okunur kontroller | `scripts/ops/rel-002-preflight.sql` (bölüm M2…M5), `scripts/ops/rel-002-round-consistency.sql` (kontrol 1–14; 0 satır = tutarlı) |
| Geri dönüş betikleri | `scripts/ops/rel-002-m2/m3/m4/m5-rollback.sql` — her biri yalnız kendi fazının verisi oluşmadan önce çalışır, aksi hâlde kendini reddeder |
| Gözlemlenebilirlik | API log'unda `rel002_event event=<ad> …` satırları (§6); admin Genel görünüm „İnceleme bekleyen eşleşmeler" hücresi, „Hizmet aksaklıkları" ve „Güvenilirlik" kuyrukları |

## 1. Deploy öncesi

1. **Sayılar** (salt-okunur):
   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/rel-002-preflight.sql
   ```
   - `_prisma_migrations` (uygulanmış) — hedef ortamın mevcut sayısı;
   - M2/M3/M4 bütünlük satırları **0**; M5 bölümü `admin_rounds = 0`,
     `match_review_not_on_failed_round = 0`;
   - bilgi: `matched_without_schedule` (M3 bölümü) — **takvimsiz eski
     eşleşmeler**; bayrak açılınca bu müşteriler destek yoluna düşer (§7).
2. **Tutarlılık**: ortamın şu an çalıştırdığı commit'in
   `rel-002-round-consistency.sql` sürümü **0 satır**. (Betik her fazda yeni
   tabloları okur: M4 öncesi DB'de `acaf9902`, M5 öncesi DB'de `36c14708`
   sürümünü kullan.)
3. **Bayrak** `serviceIssueReportingEnabled = false`:
   ```sql
   SELECT "serviceIssueReportingEnabled" FROM "OperationsSettings";
   ```
4. **Yedek**: API durdurulmuşken `scripts/ops/backup-db.sh --label pre-rel002-<commit>`,
   ardından `scripts/ops/restore-rehearsal.sh --db-dump <dosya>` geçmeli.
5. **Migration durumu**: hedef commit'in migration'ları dışında bekleyen yok;
   `migrate status` ve drift kontrolü `deploy-staging.sh` içinde koşar.

## 2. Deploy sırası

Faz 2'nin teklif takvimi sözleşmesi API ile web'i bağlar (teklif formu tarih
gönderir, API tarihi zorunlu tutar), Faz 3–5 admin ekranları yeni API
uçlarını okur. Bu yüzden **API + web + admin aynı release'te** çıkar:

1. Şema önce: guard'lı `migrate deploy` (deploy-staging.sh'nin migrate adımı).
   Ölçek provalarında her REL-002 migration'ı < 0,2 s; M5 ~20 ms (boş tablo +
   enum değeri, dolu tablo taranmaz).
2. İkinci `migrate deploy` „No pending", drift 0.
3. Sonra uygulama: api, web, admin image'ları birlikte recreate.

Eski kod yeni şemayla çalışır (her fazda canlı kanıtlandı: Faz 2 kodu M3 ile,
Faz 3 kodu M4 ile, Faz 4 kodu M5 ile `/health` 200). Yeni kod eski şemayla
**çalışmaz** — şema her zaman önce.

## 3. Deploy sonrası

1. `/health` 200 (api), web ve admin açılıyor; `scripts/ops/smoke.sh`.
2. `rel-002-preflight.sql` ve **yeni** `rel-002-round-consistency.sql` 0.
3. Bayrak hâlâ `false`.
4. Duman testi (bayrak kapalıyken anlamlı olanlar): yeni talep → teklif
   (tarihler zorunlu) → kabul → mesaj → tamamla; admin talep detayında
   „Eşleşme turları" sekmesi tek turu gösteriyor; Genel görünümde
   „İnceleme bekleyen eşleşmeler" 0.

## 4. Bayrağı açma prosedürü

Yalnız deploy kararlıyken ve ayrı onayla:

1. Önce kontrollü ortam (yerel kabul / staging). Admin „Operasyon ayarları" →
   „Hizmet aksaklığı bildirimi" → aç (onay diyaloğu).
2. Doğrula: bir test eşleşmesinde (taahhüt günü geçmiş) müşteri „Hizmetle
   ilgili sorun bildir" → Round 2 açılır; eski sağlayıcı talebi göremez/teklif
   veremez; yeni sağlayıcı teklif verir.
3. Gözle: API log'unda `rel002_event event=service_issue_reported` ve
   `event=round_reopened_automatically`; `NotificationLog`'da
   `service-issue-recorded`, `request-reopened`, `provider-incident-opened`,
   `provider-incident-new` ve `request-available:…:r2` satırları `SENT`.
4. Tutarlılık betiği 0.
5. **Geri dönüş = bayrağı kapatmak**, şema geri dönüşü değil (§5).

## 5. Acil durum

1. **Bayrağı kapat** (admin kartı ya da
   `UPDATE "OperationsSettings" SET "serviceIssueReportingEnabled" = false;`).
   Kapalı: `POST /service-requests/:id/service-issue` 404, müşteri ekranında
   CTA yok. Açılmış turlar, incident'lar, dışlamalar, admin geçmişi ve
   MATCH_REVIEW kurtarma aynen okunur/çalışır; kapatmak hiçbir veriyi geri
   almaz ve bozmaz (Faz 5 testi: bayrak kapalıyken Tur 4 açılır, geçmiş
   okunur).
2. **Şema geri dönüşü yapma**: gerçek bir Round 2, karar/yanıt ya da personel
   açılışı oluştuysa M3/M4/M5 rollback betikleri kendini reddeder — doğrusu
   budur; turlar, karar zinciri ve açılış kayıtları audit'tir.
3. **İleri-düzeltme**: hatayı kodda düzelt, normal deploy sırasıyla çık.
4. Yalnız hiçbir REL-002 verisi oluşmamışsa (bayrak hiç açılmadı, kimse
   Tur 4 açmadı): kod revert + gerekirse ilgili rollback betiği
   (en yeni fazdan geriye: M5 → M4 → M3 → M2), her biri tek transaction.

## 6. Gözlemlenebilirlik

Ayrı bir metrik yığını yok; sayaçlar log satırlarından ve admin sayılarından
okunur. Satırlar yalnız id, sayı ve enum taşır (ad, telefon, e-posta, adres,
serbest not yok):

| Olay | Satır | Sayaç karşılığı |
|---|---|---|
| Müşteri bildirimi | `event=service_issue_reported requestId= incidentId= round= reason=` | `service_issue_total` |
| Otomatik yeni tur | `event=round_reopened_automatically … failedRound= currentRound=` | — |
| MATCH_REVIEW'a giriş | `event=match_review_entered …` | — |
| Personel turu | `event=manual_round_opened requestId= fromRound= round= published= actorId=` | `manual_round_open_total` |
| İlk karar | `event=incident_adjudicated incidentId= adjudicationId= decision= …` | `confirmed_incident_total` (`decision=CONFIRMED`) |
| Düzeltme | `event=incident_correction_applied …` | — |
| Güvenilirlik incelemesi | `event=reliability_review_opened reviewId= incidentId= confirmed=` | — |

`requests_in_match_review`: admin Genel görünüm hücresi / `GET /dashboard/admin-summary`
`matchReviewRequests` / `SELECT count(*) FROM "ServiceRequest" WHERE status = 'MATCH_REVIEW'`.

## 7. Takvimsiz eski eşleşmeler (destek yolu)

Faz 2'den önce kabul edilmiş ve teklifinde taahhüt günü olmayan eşleşmeler
(yerelde 2): tarih **uydurulmaz**, backfill yapılmaz. Bayrak açıkken müşteri
ekranı form yerine destek bağlantısı gösterir („Bu eşleşmeyle ilgili bir
sorun yaşıyorsanız destek ekibimizle iletişime geçin…"); API
`SERVICE_ISSUE_REQUIRES_SUPPORT` ile reddeder. Admin „Eşleşme turları"
sekmesi aynı turda „Taahhüt tarihi yok — otomatik sorun bildirimi
kullanılamaz" der. Destek ekibi şikâyeti normal destek talebi olarak işler;
gerekirse talebi mevcut personel iptaliyle kapatır.

## 8. MATCH_REVIEW kurtarma (Round 4+)

Üç otomatik tur da hizmet aksaklığıyla biten talep `MATCH_REVIEW`'da bekler:
pazarda görünmez, zamanlayıcılar dokunmaz, müşteri iptal edebilir.

1. Admin → Genel görünüm „İnceleme bekleyen eşleşmeler" ya da
   Talepler → „Eşleşme İncelemesi" görünümü (en eski başta).
2. Talep → **Eşleşme turları** sekmesi: her tur, aksaklık kaydı ve geçerli
   karar, dışlanan sağlayıcılar, yazışma durumu. Gerekirse aksaklık ve
   güvenilirlik kayıtlarına bağlantılar.
3. Müşteriyle görüş; yeni tur gerçekten doğru adımsa **yalnız SUPER_ADMIN**:
   „Yeni tur aç" → **zorunlu iç not** (10–2000 karakter; müşteri ve sağlayıcı
   görmez) → onay diyaloğu → „Evet, Tur N'i aç".
4. Sonuç: aynı talepte Tur N+1 (`openedBy = ADMIN`, pazar yeri). Otomatik
   yayın açıksa talep hemen yayında (fan-out `request-available:…:r<N>`,
   dışlananlar hariç); kapalıysa moderasyon kuyruğunda (`SUBMITTED`), onayla
   yayınlanır. Müşteriye `request-manually-reopened` gider. Önceki turlar,
   dışlamalar, incident'lar, kredi değişmez.
5. Not **düzeltilemez**: yanlış bir açılış geçmişi değiştirilerek değil, ayrı
   bir işlemle ele alınır (v0.2.0'da böyle bir işlem yok; gerekirse talebi
   iptal et ve durumu destek kaydına yaz).
6. Tur sınırı yoktur: Tur 4 de başarısız olursa talep yine `MATCH_REVIEW`'a
   döner ve aynı adımlar Tur 5 için tekrarlanır.

Hata kodları (sayfada Türkçe cümle olarak): `MATCH_REVIEW_ALREADY_REOPENED`
(başkası açtı), `REQUEST_NOT_IN_MATCH_REVIEW`, `ROUND_CHANGED`,
`IDEMPOTENCY_KEY_REUSED`, `MATCH_REVIEW_NOTE_REQUIRED`/`_TOO_LONG`,
`SUPER_ADMIN_REQUIRED`.
