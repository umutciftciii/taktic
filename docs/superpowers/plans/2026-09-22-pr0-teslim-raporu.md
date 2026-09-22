# PR-0 — Teslim raporu (izin tabanlı admin yetkisi)

Tarih: 2026-09-22 · Branch: `claude/pr0-admin-rbac` · Taban: `origin/main` @ `fecbfc3c` (PR #104 merge) ·
Tasarım: [`2026-09-22-pr0-admin-rbac-design.md`](../specs/2026-09-22-pr0-admin-rbac-design.md) ·
Girdi: [rota eşleme tablosu](2026-09-22-pr0-route-permission-map.md)

**Kampanya motoru anahtarı bu PR'da okunmadı, yazılmadı, açılmadı.** Yerel ve staging'de kapalı.

## 1. Sayılarla

| Ölçüm | Değer |
| --- | --- |
| `AdminPermission` katalog değeri | **77** — enum, tablo değil |
| İzne bağlanan rota | **122** (119 mevcut + `PATCH /providers/:id` + iki admin katalog rotası) |
| Kök kalan rota | **2** (`POST /users`, `POST /users/:id/invite-link`) + 8 rol yönetim rotası |
| Dokunulmayan karma rollü rota | **27** |
| Dokunulmayan `ProviderAccessGuard` rotası | **21** |
| `@Roles(UserRole.SUPER_ADMIN)` kalan kullanım | **2** (72 idi) |
| Migration | **H** + **I** — 73. ve 74., ikisi de yalnız ekleme, DML yok |
| Yeni API testi | **37** (7 sözleşme + 19 davranış + 11 katalog görünürlüğü) |
| Yeni E2E testi | **2** |
| İzin kapısı eklenen admin sayfası | **46** |

## 2. Görev tanımının maddeleri

| İstenen | Nerede |
| --- | --- |
| 72 kullanımın rota + metod + aksiyon eşlemesi birebir uygulansın | 120 rota `@RequiresPermission`, 2 kök `@Roles` — `route-permission-map.ts` ve onu zorlayan test |
| 121 rota eşleme tablosundaki izinlerle korunsun | `admin-rbac-route-map.spec.ts` üç yönde doğruluyor (sınıflandırılmamış / ölü / uyuşmaz) |
| 27 karma rota davranış değişmeden kalsın | Dokunulmadı; `RolesGuard` ve `Roles` silinmedi |
| 21 `ProviderAccessGuard` rotası `ADMIN`'e açılmasın | Guard'a `ADMIN` eklenmedi; 13'ü için tüm izinli `ADMIN`'in 403 aldığı test edildi (I-7) |
| `UserRole.ADMIN` yalnız personel hesap türü olsun | `admin-permissions.ts` tek yorumlayıcı; yetki yalnız atamadan |
| Atamasız `ADMIN` panele erişemesin | `AdminAccessGuard`; test + E2E |
| `SUPER_ADMIN` tüm devredilebilir izinleri örtük taşısın | `hasPermission` erken döner; atamasız `SUPER_ADMIN` testi |
| API, menü, sayfa/aksiyon ve `/admin/me/permissions` tek kaynak | `describePermissions` → guard, `requireAdmin`, `filterNavGroups`, motor kartı |
| Her guard ve eşleme için test; sınıflandırılmamış rota kırmızı | `admin-rbac-route-map.spec.ts` ilk vakası |
| Migration, atama audit'i, bootstrap sınırları | Migration H, `AdminRoleAuditLog` (7 aksiyon), `SUPER_ADMIN` yalnız seed |

## 3. Uygulama sırasında çıkan üç bulgu

**B1 — `ensureProviderUpdateAccess` `ADMIN`'i tanımıyordu.** `PATCH /providers/:id` guard'ı geçen ama
serviste reddedilen bir `ADMIN`, `PROVIDERS_WRITE` iznini yalan hâline getiriyordu. Test bunu yakaladı
(403 beklenmiyordu). Kontrol `isStaff`'a genişletildi: fonksiyon zaten *sahiplik* hakkındaydı ve "operatör
bununla bağlı değil" diyordu; PR-0 öncesinde "operatör" yalnız `SUPER_ADMIN` olabilirdi.

**B2 — 18 yerde `role === SUPER_ADMIN` vardı ve hepsi aynı şey değildi.** Beşi *operatör görünümü*
(profil projeksiyonu, DRAFT kategori görünürlüğü) — bunlar personel hesabını tanıyacak şekilde genişletildi,
aksi hâlde aynı okuma iznini taşıyan iki personel hesabı farklı veri görürdü. On üçü *müşteri sahipliği*
(`ensureCustomerRequestAccess` ve eşleri) — bunlara **dokunulmadı**: bir operasyon personelinin müşteri adına
işlem yapması, izin kataloğunun vereceği bir yetenek değil, ayrı bir ürün kararıdır (§12.2).

**B3 — `apiFetch` 403'te `/login`'e atıyordu.** İzinler öncesinde 401 ile 403 aynı şeydi (yalnız `SUPER_ADMIN`
vardı). Şimdi izinsiz bir sayfaya giren personel sonsuz giriş döngüsüne düşerdi: 403 artık `/yetkisiz`'e gider.

## 4. Davranış değişiklikleri (dikkat)

| Değişiklik | Kim etkilenir |
| --- | --- |
| `POST /users` artık `SUPER_ADMIN` değil **`ADMIN`** üretir | Bundan sonra panelden eklenen her personel; mevcut hesaplar aynen kalır |
| Davet kabulü rolü değiştirmez, yalnız şifre yazar | Yeni davetler |
| `SUPER_ADMIN` yalnız bootstrap ile doğar | Panelden süper admin eklenemez |
| Admin kullanıcı listesi iki personel rolünü de kapsar | Liste/detay/durum rotaları |
| Son aktif **süper admin** pasifleştirilemez; `ADMIN` pasifleştirilebilir | Rol türüne göre |
| 403 → `/yetkisiz` | Admin paneli |

## 5. Doğrulama

| Kontrol | Sonuç |
| --- | --- |
| Migration H izole DB'de `migrate deploy` + drift | 73 migration, **sıfır drift** ([dry-run](2026-09-22-pr0-migration-h-dryrun.txt)) |
| `AdminPermission` DB'de değer sayısı | **76** |
| Üç kök yetki DB enum'unda | **yok** (sorgu boş döndü) |
| Partial unique index | `AdminRoleAssignment_active_unique` yerinde |
| `pnpm typecheck` (5 paket) | geçti |
| `pnpm build` (3 paket) | geçti |
| Yeni RBAC testleri | **23/23** |
| Tam API paketi | **154 dosya / 3359 test** (taban 151/3322; fark tam olarak eklenen 37 test). Tek kırmızı `account-email-role-conflict` — bilinen, bu dilimden önce de var olan yarış flake'i; tek başına 20/20 geçiyor |

**Gerçek `taktic` DB'sine dokunulmadı**; tüm migration doğrulaması `pr0_migration_dryrun` izole veritabanında.

## 6. Katalog görünürlüğü düzeltmesi (merge öncesi)

İlk hâlde DRAFT/INACTIVE kategori görünümü **panel erişimine** bağlıydı: rolü ne olursa olsun her personel
hesabı yayımlanmamış katalogu görebiliyordu. Bunu merge öncesi bir düzeltme olarak kapattım.

| Değişiklik | Ayrıntı |
| --- | --- |
| Yeni izin | **`CATALOG_READ`** (Migration I) — katalog 76 → 77 |
| Yeni rota | `GET /admin/categories`, `GET /admin/categories/:slug` |
| Public uçlar | `includeInactive` diye bir parametre **yok**; spoof edilecek bir şey yok çünkü geçirilecek bir şey yok |
| `routing/resolve` | Yalnız public katalogda yürüyor — yayımlanmamış katalogun ikinci kapısıydı |
| `elevated-query.ts` | **Silindi**; tek tüketicisi buydu |
| Yazma | `CATEGORIES_WRITE/STATUS/DELETE` ayrı kaldı; okuma yazma vermiyor |

**Mevcut testler taşındı.** Dokuz spec dosyası eski sözleşmeyi kodluyordu. Yedisinde 17 çağrı mekanik
olarak `/admin/categories`'e taşındı; `category-visibility.spec.ts` **yeniden yazıldı** (konusu tam olarak
bu sınırdı, 15 vaka); `sitemap-entries.spec.ts`'e dokunulmadı (farklı rotanın kendi parametresi).
`wave-1-release-readiness.spec.ts`'te bir bekleyiş 403 → 401/403 olarak ayrıldı: kimlik sunmayan çağıran
artık `AuthGuard`'dan 401 alıyor, müşteri/sağlayıcı 403. Eski yardımcı ikisine de 403 veriyordu; yeni
ayrım birine "giriş yap", diğerine "yetkin yok" diyor.

**Filtre listeleri kasıtlı olarak düşüyor.** Teklif/talep/sağlayıcı ekranları kategori adlarını filtre için
okuyor; bunları `CATALOG_READ`'e bağlamak yanlış bağ olurdu. `listCatalogueForFilter()` izin yoksa boş liste
döndürüyor — yönlendirme değil, çünkü bir yönlendirmeyi yutmak başka yerdeki gerçek bir reddedişin kazara
yutulma yoludur.

**Kasıtlı tek istisna:** `GET /categories/provider-enrollment` yayına girmemiş kategorileri adlandırmaya
devam ediyor (sıradaki dalganın başvuru yapabilmesi için) — ama kendi dar projeksiyonuyla; testi `status`,
`isActive`, `questions`, `children` alanlarının olmadığını doğruluyor.

## 7. Sıradaki iş

CMP-006 **PR-A** (paket iade politikası + checkout kanıtı). Bu PR'ın kataloğuna eklenecek izinler PR-A/B/C
ile birlikte gelir; hiçbiri şimdiden eklenmedi, çünkü karşılık gelen rota olmadan bir izin panelde
işaretlenebilen ama hiçbir şey açmayan bir kutudur (D11) — ve rota haritası testi bunu zaten kırmızıya
çevirirdi.

## 8. CI

PR [#105](https://github.com/umutciftciii/taktic/pull/105) · kod commit'i `609a94ad` · run
[35761161875](https://github.com/umutciftciii/taktic/actions/runs/35761161875) · **3/3 geçti**.

| Job | Sonuç |
| --- | --- |
| `typecheck · lint · test · build` | pass |
| `e2e (chromium)` | pass |
| `e2e (webkit · sign-in and mobile shells)` | pass |

Ayrıca yerelde tam E2E paketi bağımsız olarak koşuldu: **293/293 geçti** (8.2 dk).

### İlk koşu kırmızıydı — ne çıktı

`511f6f72` ile açılan ilk koşuda `typecheck · lint · test · build` geçti, iki E2E job'ı kırıldı. Log'daki
40+ kırmızı satırın yalnız **ikisi** gerçekti (16.3s süreyle); gerisi **0ms** ile "başarısız" görünüyordu,
yani paket ilk gerçek hatalardan sonra bayılmıştı. Süre sütunu, kök nedeni enkazdan ayıran şeydi.

Gerçek hata bir test kaprisi değil, **tasarımın kendisindeydi**: 403'ü toptan `/yetkisiz`'e yönlendirmek,
iki farklı durumu birbirine karıştırıyordu.

| Kim | Ne yanlış | Doğru yer |
| --- | --- | --- |
| Sağlayıcı/müşteri oturumu admin sayfasında | Yanlış türde hesapla girmiş | `/login` — izinler öncesindeki davranış |
| Rolsüz veya izinsiz personel | Doğru hesap, yetersiz yetki | `/yetkisiz` — açıklama |

Düzeltme (`609a94ad`): guard'lar reddedişi adlandırıyor — `NOT_STAFF`, `ADMIN_ACCESS_DENIED`,
`INSUFFICIENT_PERMISSION`. Panel yalnız `NOT_STAFF`'ı giriş formuna yolluyor. Kod **hangi** iznin eksik
olduğunu asla söylemiyor (onu sayan bir 403, paneli yoklayana haritayı verir) ve bu da teste bağlandı.
