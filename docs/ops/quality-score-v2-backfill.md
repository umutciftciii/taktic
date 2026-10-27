# QUALITY-SCORE-001 — Kalite puanı v2 geçişi (backfill) ve dağıtım planı

Eski modelle (v1) puanlanmış talepleri yeni modele (v2) taşır. Yeni model
zorunlu alanları puanlamaz; açıklamanın derinliğini, isteğe bağlı soruları,
bütçeyi ve zamanlamayı ölçer, uygulanmayan bileşeni paydadan çıkarır
(ayrıntı: `apps/api/src/modules/service-requests/request-quality.ts`,
sabitler `packages/shared/quality-score.json`).

Araç: `apps/api/src/scripts/backfill-quality-score-v2.ts` (image içinde
`dist/scripts/backfill-quality-score-v2.js`).

**Apply ayrı onay ister.** Bu runbook'taki `--apply` adımları, ortam ve plan
özeti onaylanmadan çalıştırılmaz.

## Ne yapar, ne yapmaz

- **Yalnız v1 satırlar:** `qualityScoreVersion < 2` olan her talep. Deploy'dan
  sonra oluşturulan talepler zaten v2 yazılır.
- **Değişen yalnız üç kolon:** `qualityScore`, `qualityScoreBreakdown`,
  `qualityScoreVersion` (1 → 2). `updatedAt` dahil başka hiçbir kolon
  değişmez (admin'deki "Güncellendi" tarihi kaymaz). Kredi, teklif, eşleşme
  turu, kampanya ve zamanlayıcı tablolarına dokunulmaz; bunların hiçbiri puanı
  okumaz.
- **Hesap aynı:** puanı, admin'in "Kaliteyi yeniden hesapla" düğmesinin
  çalıştırdığı `scoreStoredRequest` hesaplar; kategorinin etkin formu ve
  talebin kayıtlı cevapları üzerinden.
- **Plan önce:** `plan` salt okunur (READ ONLY transaction). Her satırın önceki
  ve sonraki puanını, etiket geçişlerini ve dikkat isteyen satırları
  (`form changed since sent`, `no prior breakdown`) bir manifeste yazar ve
  özetini (digest) basar.
- **Apply tam planı uygular ya da hiçbir şey yapmaz:** tek SERIALIZABLE
  transaction; `--confirm-digest` planın digest'ini tekrarlamalı; v1 satır
  kümesi planınkiyle birebir aynı olmalı; her satır yeniden okunur, yeniden
  hesaplanır, plandakiyle karşılaştırılır ve eski değerleriyle korunan bir
  yazımla güncellenir. Tek bir fark bütün çalıştırmayı reddeder.
- **İdempotent:** apply'dan sonra v1 satır kalmaz; yeni plan boş çıkar, eski
  plan reddedilir.
- **Geri alınabilir:** `rollback`, applied manifestindeki her satırın eski
  puanını, sürümünü ve kırılımını geri yazar (kırılımı olmayan satır yine
  boş kalır). Apply'dan sonra değişmiş bir satır (ör. yeniden hesaplanmış)
  rollback'i reddeder.
- **Kişisel veri yok:** manifestlerde talep id'si, numarası, durumu ve
  puanlar vardır; ad, telefon, e-posta, adres, açıklama yoktur. Dosyalar repo
  dışına, `--out`/`$TAKTIC_OPS_OUTPUT_DIR`/`~/Backups/taktic/ops` altına 0600
  ile yazılır.

Çıkış kodları: 0 tamam, 1 hata, 2 red (hiçbir şey değişmedi), 3 serileştirme
çakışması (planı yeniden al). `pnpm` sarmalayıcısı sıfır olmayan her kodu 1'e
indirir; kodu görmek için image içindeki `node dist/...` yolunu kullanın.

## Geçiş sırasında v1/v2 karışıklığı neden zararsız

Deploy ile backfill arasında v1 ve v2 satırları birlikte bulunur. Kod bunu
güvenli kılar, bu yüzden bakım penceresi (API durdurma) gerekmez:

| Risk | Önlem (PR-1/PR-2'de) |
|---|---|
| Şişkin v1 puanları (55–100) yeni v2 taleplerini hizmet veren akışında aşağı iter | Akış sıralaması `qualityScoreVersion desc, qualityScore desc, submittedAt desc`: v2 talep her zaman v1'in üstünde |
| v1 puanı v2 eşikleriyle okunup yanlış etiket alır | Etiket, puanı yazan modelin eşikleriyle okunur (v1: 80/50, v2: 70/40 + açıklama kapısı) |
| Admin tek tek "yeniden hesapla" ile backfill'i onaysız başlatır | v1 satırda yeniden hesaplama 409 `QUALITY_SCORE_BACKFILL_PENDING` döner |
| Plan ile apply arasında v1 kümesi değişir | v1 satır yalnız backfill ile değişebilir; yeni talepler v2 doğar. Yine de apply kümeyi ve her satırı yeniden doğrular |
| Müşteri v1 talepte boş öneri görür | v1 satırda öneri listesi boştur, etiket gösterilir; ekran bozulmaz |

Pencereyi kısa tutmak yine de iyidir: aynı oturumda plan → onay → apply.

## Dağıtım sırası

1. PR-1 (model + migration) → PR-2 (müşteri/filtre/form) → PR-3 (bu araç)
   merge edilir. PR-2 ve PR-3 birbirinden bağımsızdır; ikisi de PR-1'e
   dayanır. **Deploy üçü birlikte main'deyken yapılır** (PR-1 tek başına
   deploy edilirse hizmet veren filtresi geçici olarak sayısal kalır).
2. Ortam başına sıra: yerel → staging → production. Her ortamda aşağıdaki
   adımlar; staging sonucu onaylanmadan production'a geçilmez.

## Ortak hazırlık

```bash
# Hedef ortamda, repo kökünde, deploy edilmiş image ile. Komut kısaltması:
qsb() {
  docker compose -f docker-compose.prod.yml run --rm --no-deps -T \
    -e TAKTIC_OPS_OUTPUT_DIR=/out -v "$HOME/Backups/taktic/ops:/out" \
    api node dist/scripts/backfill-quality-score-v2.js "$@"
}
```

## Adımlar

1. **Deploy** (migration `20261027090000_add_request_quality_score_version`
   deploy sırasında uygulanır; eklemeli: mevcut satırlar `qualityScoreVersion = 1`).
   Doğrulama:

   ```sql
   SELECT "qualityScoreVersion", count(*) FROM "ServiceRequest" GROUP BY 1;
   -- deploy anında: yalnız 1; deploy sonrası yeni talepler 2
   ```

2. **Plan (salt okunur):**

   ```bash
   qsb plan
   ```

   Özeti kaydedin: satır sayısı, etiket önce/sonra, geçişler, durumlara göre
   dağılım, `form changed since sent` ve `no prior breakdown` sayıları, digest.
   `form changed since sent > 0` ise o satırlar bugünkü formla puanlanır;
   manifestten id'leri inceleyin.

3. **Onay:** plan özeti ve digest ile ayrı onay alın.

4. **Yedek:**

   ```bash
   scripts/ops/backup-db.sh --label pre-quality-score-v2
   ```

5. **Apply (önce kuru):**

   ```bash
   qsb apply --plan /out/quality-score-v2-<stamp>-plan.json --confirm-digest <digest>
   qsb apply --plan /out/quality-score-v2-<stamp>-plan.json --confirm-digest <digest> --apply
   ```

   Red (çıkış 2) gelirse hiçbir şey değişmemiştir; `qsb plan` ile yeni plan
   alın ve 3. adıma dönün.

6. **Doğrulama:**

   ```bash
   qsb plan   # rows: 0 olmalı
   ```

   ```sql
   SELECT "qualityScoreVersion", count(*) FROM "ServiceRequest" GROUP BY 1;  -- yalnız 2
   ```

   Admin'de bir talebin kırılımı dört satır gösterir (açıklamanın ayrıntısı,
   isteğe bağlı sorular, bütçe, zamanlama) ve "Eski model" rozeti kaybolur;
   "Kaliteyi yeniden hesapla" puanı değiştirmez (aynı hesaplayıcı).

## Geri alma

```bash
qsb rollback --manifest /out/quality-score-v2-<stamp>-applied.json          # kuru
qsb rollback --manifest /out/quality-score-v2-<stamp>-applied.json --apply
```

- Yalnız manifestteki satırlar, yalnız apply'dan beri dokunulmamışlarsa geri
  yazılır; aksi halde red.
- **Kodu eski bir image'a geri almadan önce rollback'i çalıştırın.** Eski kod
  `qualityScoreVersion` kolonunu tanımaz (eklemeli olduğu için boot eder) ama v2
  kırılımını eski eşiklerle okur. Migration geri alınmaz; kolon kalır.

## Yerel stack

Merge sonrası yerel eşitlemede migration `npx prisma migrate deploy` (ya da
compose akışı) ile uygulanır. Yerel veride backfill isteğe bağlıdır ve aynı
araçla yapılır:

```bash
pnpm --filter @taktic/api quality:backfill -- plan
```

## Prova (2026-10-27, yerel kopya üzerinde)

Yerel geliştirme veritabanının geçici bir kopyasında (23 talep, hepsi v1)
migration uygulandı, ardından plan → apply → rollback koşuldu; kopya sonra
silindi:

- plan: 23 satır; etiket HIGH 10 / MEDIUM 13 / LOW 0 → HIGH 0 / MEDIUM 6 /
  LOW 17; `no prior breakdown` 1; manifestler 0600.
- yanlış digest → red (çıkış 2); kuru apply → red yok; apply → 23 satır v2;
  ikinci apply → 23 "no longer an original-model row" reddi; yeni plan 0 satır.
- apply sonrası talebin kalite dışı kolonları (`updatedAt` dahil) ve
  Offer / ProviderCreditTransaction / ServiceRequestMatchRound / PromoCreditLot
  parmak izleri değişmedi.
- rollback → kalite kolonları önceki haliyle birebir; diğer kolonlar aynı.
