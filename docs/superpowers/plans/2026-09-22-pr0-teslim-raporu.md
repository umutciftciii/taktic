# PR-0 — Teslim raporu (izin tabanlı admin yetkisi)

Tarih: 2026-09-22 · Branch: `claude/pr0-admin-rbac` · Taban: `origin/main` @ `fecbfc3c` (PR #104 merge) ·
Tasarım: [`2026-09-22-pr0-admin-rbac-design.md`](../specs/2026-09-22-pr0-admin-rbac-design.md) ·
Girdi: [rota eşleme tablosu](2026-09-22-pr0-route-permission-map.md)

**Kampanya motoru anahtarı bu PR'da okunmadı, yazılmadı, açılmadı.** Yerel ve staging'de kapalı.

## 1. Sayılarla

| Ölçüm | Değer |
| --- | --- |
| `AdminPermission` katalog değeri | **76** — enum, tablo değil |
| İzne bağlanan rota | **120** (119 mevcut + `PATCH /providers/:id`) |
| Kök kalan rota | **2** (`POST /users`, `POST /users/:id/invite-link`) + 8 rol yönetim rotası |
| Dokunulmayan karma rollü rota | **27** |
| Dokunulmayan `ProviderAccessGuard` rotası | **21** |
| `@Roles(UserRole.SUPER_ADMIN)` kalan kullanım | **2** (72 idi) |
| Migration | **H** — 73. migration, DML yok, `ALTER COLUMN` yok |
| Yeni API testi | **23** (7 sözleşme + 16 davranış) |
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
| Tam API paketi | **153 dosya / 3345 test, hepsi geçti** (taban 151/3322 — fark tam olarak eklenen 23 test) |

**Gerçek `taktic` DB'sine dokunulmadı**; tüm migration doğrulaması `pr0_migration_dryrun` izole veritabanında.

## 6. Sıradaki iş

CMP-006 **PR-A** (paket iade politikası + checkout kanıtı). Bu PR'ın kataloğuna eklenecek izinler PR-A/B/C
ile birlikte gelir; hiçbiri şimdiden eklenmedi, çünkü karşılık gelen rota olmadan bir izin panelde
işaretlenebilen ama hiçbir şey açmayan bir kutudur (D11) — ve rota haritası testi bunu zaten kırmızıya
çevirirdi.

## 7. CI

| Job | Sonuç |
| --- | --- |
| — | PR açıldıktan sonra doldurulacak |
