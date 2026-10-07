# SEO-004 PR A — SEO Core: teslim raporu

Tarih: 2026-10-07 · Base: `main@9c14c50f` · Dal: `claude/seo-004-pr-a-core`

Kapsam: Faz 0 analizinin backend çekirdeği. Admin ekranları (4 SEO ekranı, nav
grubu, modallar) PR B'dir; bu PR'da UI yoktur. Staging/production ve backlog'a
dokunulmadı; aktif yerel DB'ye migration uygulanmadı.

## Kilitli kararların karşılığı

| Karar | Uygulama |
|---|---|
| Tek slug sahibi `ServiceCategory` | İşletme/kart slug'ı eklenmedi; slug ekranı yalnız kategori listeler |
| Public kategori → 301 zorunlu, aynı transaction, opt-out yok | `SeoRedirectGraphService.applyCategorySlugChange`, `updateCategory`'nin serializable transaction'ı içinde; opt-out parametresi yok |
| Public olmayan → redirect yok | `wasPublic = isPubliclyReachable(current)`; false ise yalnız slug değişir |
| Manuel 301/302, slug yalnız 301 | `SeoRedirectType`; CHECK `SeoRedirect_slug_change_shape`; update'te `SEO_SLUG_REDIRECT_PERMANENT` |
| Genel 404'te otomatik redirect yok | Recorder yalnız kaydeder; redirect yalnız admin onayıyla |
| Hit/ziyaret metriği yok | Hiçbir yanıtta yok (testle kilitli) |
| `seoPageDetail` kapsam dışı | Endpoint yok |
| İzinler `SEO_READ`, `SEO_CONTENT_WRITE`, `SEO_REDIRECTS_WRITE`, root-only değil | Enum 84→87; rota haritasında |
| Öneri onay/ret `SEO_REDIRECTS_WRITE` | Rota haritası + test |
| Query/hash korunmaz | Middleware Location'ı yalnız hedef yoldan kurar |
| Canlı trailing-slash/case redirect'i yok | Middleware yalnız snapshot'taki kaynaklara bakar |
| Geçmiş slug backfill'i yok | Migration'da redirect üretilmez |

## Şema

`ServiceCategory` (+6, hepsi nullable, default yok): `seoTitle` (≤70),
`seoDescription` (≤160), `editorialDecisionGuide`, `editorialPriceFactors`
(≤6000), `editorialFaq` (jsonb dizi, 1–20), `illustrationKey` (slug biçimi).

`SeoRedirect`: id, sourcePath, targetPath, type, active, origin, reason,
categoryId (FK yok), createdById/updatedById/deactivatedById (Restrict),
deactivatedAt, createdAt, updatedAt. Kısmi unique `(sourcePath) WHERE active`,
kısmi indeks `(targetPath) WHERE active`, `categoryId` indeksi; CHECK'ler: yol
biçimi, `source <> target`, deaktivasyon kaydı (inactive ⇔ deactivatedAt +
deactivatedById), slug-change ⇒ PERMANENT + categoryId, reason uzunluğu;
`BEFORE DELETE` trigger'ı hard delete'i reddeder.

`SeoNotFoundPath`: path (unique), routeFamily, first/lastSeenAt,
occurrenceCount, seenDays, status (OPEN/APPROVED/REJECTED),
candidateTargetPath, decidedById, decidedAt, redirectId; indeksler
`(status, occurrenceCount)`, `(lastSeenAt)`; CHECK'ler sayaçları ve karar
kaydını tutarlı tutar.

`SeoAuditLog`: entityType (REDIRECT/NOT_FOUND_PATH), entityId, action (7
değer), changes (jsonb dizi), reason, actorId, createdAt.
`AdminAuditDomain` += `SEO_REDIRECT`, `SEO_NOT_FOUND_PATH`.

## Migration'lar

1. `20261007120000_add_seo_core` — enum'lar, 3 izin, kolonlar, 3 tablo,
   CHECK'ler, kısmi indeksler, delete trigger. DML yok.
2. `20261007120100_backfill_category_illustration_key` — tek kontrollü DML:
   yalnız 7 bilinen slug'da ve yalnız `illustrationKey IS NULL` iken
   `illustrationKey = slug` (web'in daha önce slug'la baktığı değerin aynısı).

Geri alma: kolonlar/tablolar DROP edilebilir (yalnız yeni içerik kaybolur);
enum değerleri PostgreSQL'de geri alınamaz (kullanılmasa zararsız).

## Migration provası (izole)

- Taze yedek: `~/Backups/taktic/db/taktic-db-20261007T160948Z-pre-seo-004-pr-a-rehearsal.dump`
  (sha256 `7b8ffe50…87e4a`, 95 tablo, 88 migration).
- `scripts/ops/restore-rehearsal.sh`: restore hatasız, 88 migration ve tüm
  tablo/satır sayıları manifest'le eşleşti.
- Ayrı atılabilir PostgreSQL 16.6 (tmpfs, yalnız 127.0.0.1), dump restore →
  bu dalın `prisma migrate deploy`'u:
  - 88 → 90; ikinci deploy "No pending migrations"; `migrate status` up to date;
  - drift (`migrate diff --from-url --to-schema-datamodel --exit-code`) = 0;
  - satır toplamı 999 → 999; `ServiceCategory` mevcut kolon özeti
    `3178aaf2…` → aynı; diğer tüm mevcut tabloların veri özeti `75aa33fd…` → aynı;
  - illustrationKey: 7 satır, hepsi kendi slug'ı, uyuşmazlık 0;
  - SEO içerik kolonları dolu satır 0; yeni tablolar boş; izin sayısı 87;
    26 constraint; delete trigger 1.
- Konteyner çıkışta silindi. Aktif yerel DB'de hiçbir migration çalışmadı
  (hâlâ 88).

## Gerekçe motoru

`evaluateX(facts) → { indexable, reasons[] }`, `isX = evaluateX().indexable`.
Kodlar yalnız mevcut kurallardan: `INPUT_UNRECOGNIZED`, `CATEGORY_NOT_ACTIVE`,
`CATEGORY_NOT_LEAF`, `CATEGORY_DESCRIPTION_TOO_SHORT`,
`CATEGORY_EDITORIAL_BLOCK_MISSING`, `CATEGORY_EDITORIAL_BLOCK_TOO_SHORT`,
`PROVIDER_NOT_APPROVED`, `PROVIDER_DESCRIPTION_TOO_SHORT`,
`PROVIDER_LOCATION_MISSING`, `PROVIDER_NO_PUBLIC_CATEGORY`,
`PROVIDER_NO_SERVICE_AREA`, `PROVIDER_SERVICE_AREA_INCOMPLETE`,
`CARD_NOT_LIVE`, `CARD_PROVIDER_NOT_INDEXABLE`, `CARD_SUMMARY_DUPLICATED`,
`CARD_SUMMARY_TOO_SHORT`, `CARD_SCOPE_INCLUDED_TOO_FEW`,
`CARD_SCOPE_EXCLUDED_TOO_FEW`, `SHELF_TOO_FEW_INDEXABLE_CARDS`. Public
projeksiyonlar yalnız boolean taşır; gerekçeler yalnız `SEO_READ` ile.
400 rastgele girdiyle `isX ⇔ reasons boş` eşdeğerliği testli.

## Admin API (PR B için)

| Rota | İzin |
|---|---|
| `GET /admin/seo/overview` | SEO_READ |
| `GET /admin/seo/pages?type&reason&q&page` | SEO_READ |
| `GET /admin/seo/slugs?q&page` | SEO_READ |
| `GET /admin/seo/categories/:id/slug-preview?slug` | SEO_READ |
| `POST /admin/seo/categories/:id/slug` | CATEGORIES_WRITE |
| `GET /admin/seo/categories/:id/content` | SEO_READ |
| `PATCH /admin/seo/categories/:id/content` | SEO_CONTENT_WRITE |
| `GET /admin/seo/redirects`, `GET …/:id` (geçmişle) | SEO_READ |
| `POST /admin/seo/redirects`, `PATCH …/:id`, `POST …/:id/deactivate` | SEO_REDIRECTS_WRITE |
| `GET /admin/seo/not-found` | SEO_READ |
| `POST /admin/seo/not-found/:id/approve`, `…/reject` | SEO_REDIRECTS_WRITE |
| `GET /seo/redirects/active` (public, no-store) | — |

Overview'daki site durumu API ortamından, web'in kuralıyla okunur
(`seo-site-gate.ts`; iki taraf da `packages/shared/seo-site-gate-cases.json`
ile test edilir; yanıt `source: API_ENVIRONMENT` der).

## Slug yaşam döngüsü

Tek yol: `CategoriesService.updateCategoryWithOutcome` (form PATCH'i ve SEO
slug rotası). Normalizasyon (`category-slug.ts`): Türkçe harf çevirisi, aksan
silme, küçük harf, `[^a-z0-9]+ → -`, tire sadeleştirme, ≤80, mevcut regex,
küçük rezerve liste. Transaction: graf kilidi → satır okuma → yetki deltası →
slug yazma → (public ise) RECLAIM / RETARGET / 301 → catalog audit → commit.
Redirect yazılamazsa slug geri döner (trigger'la hata enjekte edilerek testli).

## Redirect graf kuralları

Bir kaynakta tek aktif kayıt; zincir yok (hedef başka bir aktif kaynağın
kendisi olamaz; kaynak başka redirect'lerin hedefi olamaz); döngü bu yüzden
imkânsız; hedef yazılırken canlı, kaynak canlı değil. Tüm yazımlar
serializable + `pg_advisory_xact_lock(hashtextextended('seo-redirect-graph'))`.
Kaynak değişmez; hedef/tür/sebep düzenlenir; kaldırma = deaktivasyon.

## Middleware / snapshot

`apps/web/middleware.ts` (Node runtime): GET/HEAD; `/api`, `/_next` ve noktalı
yollar hariç. Snapshot TTL 60 sn, bayat ama kullanılabilir ≤10 dk (arkada
yenileme), sonrası boş; hata sonrası 10 sn geri çekilme, fetch zaman aşımı
1,5 sn. Satırlar yeniden doğrulanır (normalize-değişmez, sayfa biçimi,
301/302). Location: yapılandırılmış origin + hedef, origin eşitliği kontrolü;
origin yoksa göreli yol; istek Host'u asla. 301 `max-age=3600`, 302 `no-store`.

## 404 önerileri

Yalnız public kategori/işletme/kart lookup 404'leri (personel isteği hariç).
Yalnız normalize yol + aile + sayaçlar; query/hash/IP/UA/cookie/kullanıcı
yok. `@` veya ≥7 ardışık rakam içeren segment kaydedilmez. Bellek tamponu
≤200 (yol, gün) anahtarı, dakikada bir flush, OPEN ≤5000. REJECTED/APPROVED
yol bastırılır. Saklama: `seo-not-found-retention` işi (SchedulerRun lease'li,
anahtarsız, varsayılan `40 4 * * *`, `SEO_NOT_FOUND_RETENTION_CRON` ile
değiştirilebilir, zorunlu değil). Aday yalnız: slug kuralıyla çevrilmiş segment
canlı bir kategori slug'ıysa.

## Sitemap / canonical

`/vitrin` yalnız raf indekslenebilirse; API `showcaseShelf.indexable` döner,
web bunu `=== true` ile okur. Slug değişince sitemap yeni slug'ı listeler,
eski adres middleware'den 301; canonical API'nin döndürdüğü slug'dan.

## Kategori görseli

Web'in illüstrasyon haritası `illustrationKey`'e bağlandı; anahtar public
kategori listesi/detayı, vitrin kartı, müşteri talebi, işletme talep listesi ve
başvuru kategorilerinde döner.

## Audit

Slug ve SEO içeriği `CatalogAuditLog`'da (5 yeni alan, FAQ JSON metni olarak).
Redirect CREATED/UPDATED/DEACTIVATED/RETARGETED/RECLAIMED ve öneri
APPROVED/REJECTED `SeoAuditLog`'da; aktör = işlemi yapan operatör.

## Testler

- Yeni API: `seo-004-pure` (88), `seo-004-slug-lifecycle` (16, eşzamanlılık
  dahil), `seo-004-redirects` (30, URL güvenlik matrisi + RBAC),
  `seo-004-not-found` (11), `seo-004-content-overview` (6).
- Güncellenen: `sitemap-entries`, `admin-rbac-route-map` (84→87),
  `category-provider-enrollment` (illustrationKey).
- Tam API suite (1×): 207 dosya, 4573 test, hepsi geçti.
- Web: 49 dosya / 456 test (yeni: `seo-redirects`, `seo-middleware`,
  `category-editorial`; güncel: `seo-sitemap`); `next build` middleware'i
  Node runtime ile kaydetti.
- Admin unit: 36 dosya / 996 test. Repo typecheck temiz.
- E2E (izole `taktic_seo004_e2e`): `seo-indexing` + yeni `seo-redirects`
  public smoke, 12/12 (eski slug 301, yeni slug 200 + canonical, sitemap,
  manuel 302, bilinmeyen 404).

## PR B'ye kalanlar

- 4 ekran + nav grubu (`nav.spec.ts:68` çevrilecek) + modallar.
- Kategori formundaki "Kısa ad değişirse mevcut bağlantılar kırılır" metni
  artık public kategoriler için doğru değil (301 var); PR B'de güncellenmeli.

## Bilinen sınırlar

- Slug değişince eski slug'la açık kalmış talep formu/taslak (`categorySlug`)
  404/400 alır; redirect yalnız sayfa adreslerini kapsar.
- Snapshot TTL'i kadar (≤60 sn) eski adres 404 verebilir.
- Rastgele bir cuid ≥7 ardışık rakam içerirse o adresin 404'ü kaydedilmez
  (PII koruması lehine bilinçli ödünleşim).
- `GET /seo/redirects/active` throttle'sız; maliyeti birkaç sorgu.
