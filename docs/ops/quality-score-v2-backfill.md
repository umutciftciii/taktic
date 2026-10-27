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
# Hedef ortamda, repo kökünde (checkout = deploy edilen commit). Komut kısaltması:
qsb() {
  local tag
  tag="$(git rev-parse HEAD)" || return 1
  # Araç yalnız çalışan API'nin image'ıyla koşar: checkout ile çalışan image
  # ayrışmışsa (yarım kalmış deploy, elle geri dönüş) hiçbir şey çalıştırma.
  if [ "$(docker inspect -f '{{.Config.Image}}' taktic-api)" != "taktic-api:$tag" ]; then
    echo "qsb: taktic-api taktic-api:$tag değil; dur" >&2
    return 9
  fi
  TAKTIC_IMAGE_TAG="$tag" docker compose -f docker-compose.prod.yml run --rm --no-deps -T \
    -e TAKTIC_OPS_OUTPUT_DIR=/out -v "$HOME/Backups/taktic/ops:/out" \
    api node dist/scripts/backfill-quality-score-v2.js "$@"
}
```

`docker-compose.prod.yml` image adını `TAKTIC_IMAGE_TAG`'den kurar ve değişken
tanımlı değilse komutu reddeder (`TAKTIC_IMAGE_TAG must name the built
commit`); varsayılana düşüp başka bir sürümü çalıştırmaz. Etiketi elle yazmayın:
yukarıdaki fonksiyon checkout'tan alır ve çalışan API'yle aynı olduğunu
doğrular. `--confirm-digest` gibi elle kopyalanan değerlerle birlikte yanlış
bir etiket, planı başka bir modelin hesaplayıcısıyla doğrulamak demektir.

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

### Kodu önceki sürüme döndürme

`deploy-staging.sh` bu yol için kullanılamaz: preflight, veritabanında
commit'in içermediği bir migration görünce durur
(`scripts/ops/deploy-preflight.sh`, "the database has applied migrations this
commit does not contain"). 105. migration uygulandıktan sonra daha eski bir
commit'in deploy'u bu yüzden adım 1'de reddedilir. Bu doğru davranıştır; aşağıdaki
elle dönüş yalnız ileri düzeltme mümkün değilse ve ayrı onayla yapılır.

Önce ileri düzeltmeyi değerlendirin (düzeltme commit'i → normal deploy). Elle
dönüş gerekiyorsa, sırayla:

1. Backfill uygulandıysa veriyi geri alın (önce kuru, sonra `--apply`):

   ```bash
   qsb rollback --manifest /out/quality-score-v2-<stamp>-applied.json
   qsb rollback --manifest /out/quality-score-v2-<stamp>-applied.json --apply
   ```

   Bu adım yeni image çalışırken yapılır (`qsb` çalışan image'la checkout'un
   aynı olmasını şart koşar).

2. Önceki image'ların makinede durduğunu doğrulayın (`PREV` = önceki deploy
   commit'inin tam SHA'sı; deploy log'unun son satırı "previous API image"
   olarak yazar):

   ```bash
   PREV=<önceki tam sha>
   for t in api web admin; do
     docker image inspect -f "{{index .Config.Labels \"org.opencontainers.image.revision\"}}" "taktic-$t:$PREV"
   done
   ```

   Her satır `$PREV` olmalı. Image silinmişse `scripts/ops/build-images.sh
   "$PREV"` ile yeniden üretin (çalışan hiçbir şeye dokunmaz).

3. Yalnız uygulama container'larını önceki image'la yeniden oluşturun.
   PostgreSQL'e dokunulmaz (`--no-deps`, servisler adıyla); checkout yeni
   commit'te kalır, çünkü veritabanı o commit'in şemasındadır ve bir sonraki
   ileri deploy oradan devam eder:

   ```bash
   TAKTIC_IMAGE_TAG="$PREV" docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate api
   # API healthy olduktan sonra:
   TAKTIC_IMAGE_TAG="$PREV" docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate web admin
   ```

   Bu iki `compose` komutu, iki commit arasında `docker-compose.prod.yml` aynı
   kaldığı sürece güvenlidir; değiştiyse önceki commit'in dosyasını
   `git show "$PREV":docker-compose.prod.yml > /tmp/prev-compose.yml` ile alıp
   `-f /tmp/prev-compose.yml --project-directory .` ile kullanın.

4. Doğrulayın: `docker inspect -f '{{.Config.Image}} {{.State.Health.Status}}'
   taktic-api taktic-web taktic-admin` önceki etiketi ve `healthy` göstermeli;
   `curl -fsS http://127.0.0.1:3001/health`. Elle dönüşten sonra `qsb`
   checkout ile çalışan image ayrıştığı için çalışmayı reddeder; bu beklenir.

5. Son çare veritabanı geri yüklemesidir (deploy öncesi yedek,
   `db/taktic-db-<stamp>-pre-deploy-<sha>.dump`): yedekten sonra yazılan her şey
   kaybolur. Ayrı onay ister ve bu runbook'un kapsamı dışındadır.

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

## Staging (2026-10-27)

`341113ed` deploy edildi (`deploy-staging.sh --sha … --allow-empty-uploads
--skip-build`; preflight 0 hata, bekleyen yalnız 105; API ~16 sn kapalı), ardından
yukarıdaki adımlar `qsb` ile koşuldu:

- deploy sonrası 17 talep `qualityScoreVersion = 1`; sekiz veri grubunun
  parmak izi deploy öncesiyle aynı; v1 satırda yeniden hesaplama 17/17
  `409 QUALITY_SCORE_BACKFILL_PENDING`.
- plan: 17 satır, HIGH 14 / MEDIUM 3 / LOW 0 → HIGH 0 / MEDIUM 7 / LOW 10;
  `form changed since sent` 0, `no prior breakdown` 1. Digest, deploy'dan önce
  aynı kodun READ ONLY bir transaction'da (kolon yerine version=1 vererek)
  hesapladığıyla birebir aynıydı.
- yedek → kuru apply (ret yok) → `--apply`: 17/17 v2, yeni plan 0 satır; 4
  talep 40'ın üstünde puanla 5 kelime kapısı yüzünden LOW. Parmak izinde yalnız
  talebin kalite kolonları değişti; `updatedAt` dahil diğer yedi grup aynı.
- kuru rollback: ret yok (17 satır geri yazılabilir); çalıştırılmadı.
