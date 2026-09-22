# PR-0 — İzin tabanlı admin yetkisi (RBAC temeli)

Tarih: 2026-09-22 · Taban: `origin/main` @ `fecbfc3c` (PR #104 merge, temiz worktree doğrulandı) ·
Branch: `claude/pr0-admin-rbac` · Bağlayıcı girdiler:
[CMP-006 S0 tasarımı](2026-09-22-cmp-006-s0-refund-rbac-fraud-channel-design.md) §6, D11–D13 ·
[RG-7 rota eşleme tablosu](../plans/2026-09-22-pr0-route-permission-map.md) §3, §12.

Kampanya motoru (`campaignEngineEnabled`) bu PR'da **okunmaz, yazılmaz, açılmaz**; yerel ve staging'de kapalı kalır.

---

## 1. Ne değişti, tek cümlede

Admin yetkisi sabit bir rol enum'undan (`@Roles(UserRole.SUPER_ADMIN)`) **operatörün tanımladığı rollere bağlı,
sabit bir izin kataloğuna** taşındı; `SUPER_ADMIN` tüm izinleri örtük taşımaya devam ediyor ve üç kök yetki
kataloğa hiç girmediği için hiçbir role devredilemiyor.

## 2. Kararlar

| # | Karar | Gerekçe |
| --- | --- | --- |
| P1 | **`AdminPermission` bir Prisma enum'u, tablo değil.** 77 değer. | Panelden izin adı üretilemesin (D11). Enum değeri olmayan bir ad `AdminRolePermission`'a yazılamaz — kısıt uygulama kuralı değil, tipin kendisi. |
| P2 | **Rol dinamik.** `AdminRole` + `AdminRolePermission` + `AdminRoleAssignment`; anahtar benzersiz ve yeniden kullanılmaz, rol **silinmez**, pasifleştirilir. | Yetkinin *şekli* operatörün, *sözlüğü* değil. Atama ve audit satırları role bakar; "geçen mart kim neyi yapabiliyordu" cevaplanabilir kalmalı. |
| P3 | **Üç kök yetki kataloğa girmez:** rol tanımlama, personel hesabı oluşturma, davet bağlantısı mintleme. Rotaları `@Roles(UserRole.SUPER_ADMIN)` ile kalır. | RG-7 §12.1. Kendine izin ekleyebilen bir rol, izin modeli değildir. |
| P4 | **`UserRole` += `ADMIN`.** Yetenek adı değil, personel **hesap türü**; yetki yalnız atanmış rollerden gelir. | Hesap başına tek rol kuralı (`User.email @unique` + `User.role`) yeni bir değer gerektiriyordu. |
| P5 | **Atamasız `ADMIN` panele giremez.** `AdminAccessGuard`: `SUPER_ADMIN` ⟶ geç; `ADMIN` ⟶ en az bir **aktif** role **canlı** ataması varsa geç; diğerleri 403. | Hiçbir şey verilmemiş bir personel hesabına panel de verilmemiştir. Davet ile ilk atama arasındaki aralıkta hesabın *var olması* normal, *girebilmesi* değil. |
| P6 | **Tek izin kaynağı:** `GET /admin/me/permissions`. Rota guard'ı, menü, liste, detay ve aksiyon aynı yanıtı okur. | D13. İki kaynak olursa biri er geç diğerinden geniş olur. |
| P7 | **İzinler oturum okumasında çözülür**, her istekte yeniden; hiçbir yerde cache yok. | Oturum satırı zaten her kimlikli istekte okunuyor: bir join, rota başına ikinci sorgu değil. Rol değişikliği operatörün **bir sonraki tıklamasında** geçerli olur, bir sonraki girişinde değil. |
| P8 | **Pasif rol = herkesten alınan yetki.** İzin okuması `revokedAt: null` **ve** `role.isActive` filtreler. | Bir yeteneği herkesten aynı anda geri almanın yolu; tek bir atama satırına dokunulmaz, rol yeniden aktifleşirse geri gelirler. |
| P9 | **Davet zinciri:** `POST /users` artık `ADMIN` üretir; davet kabulü **rolü değiştirmez**, yalnız şifre yazar. `SUPER_ADMIN` yalnız bootstrap (`prisma/seed.ts`) ile doğar; terfi rotası yoktur. | RG-7 §12.1. Eskiden "bir meslektaş ekleme" yetkisi, "her şeyi yapabilen ve daha fazlasını ekleyebilen birini ekleme" yetkisiydi. |
| P10 | **21 `ProviderAccessGuard` rotası RBAC dışında.** Guard'ın `SUPER_ADMIN` kısa devresi korunur, `ADMIN` eklenmez, hiçbiri izne bağlanmaz. | RG-7 §12.2. Mock ödeme ve "sağlayıcı adına teklif verme" dahil; admin impersonation yok. |
| P11 | **27 karma rollü rota dokunulmaz.** | RG-7 §12.2. Bunlar müşteri/sağlayıcı rotalarıdır; `RolesGuard` ve `Roles` bu yüzden **silinmez**. |
| P12 | **`PATCH /providers/:id` için `@RequiresPermissionFromStaff`.** İzin yalnız personel çağıranından istenir; sağlayıcının kendi yolu ve servisteki sahiplik kuralları aynen kalır. | RG-7 §12.3. `@RequiresPermission` her personel-olmayanı reddederdi ve rotayı asıl sahiplerinden alırdı. |
| P13 | **`CAMPAIGN_ENGINE_TOGGLE` ayrı.** Rota, menü kartı ve aksiyon düğmesi ayrı kontrol eder. | RG-7 §12.4. Diğer dört ayar bir çalışma tercihi; bu, promosyon kredisi dağıtımını başlatan tek karar. |
| P14 | **Operatör *görünümü* kontrolleri personel hesabını tanır; müşteri *sahipliği* kontrolleri tanımaz.** | §5. İkisi farklı sorular: "bu kişi operatör mü" ile "bu kayıt bu kişinin mi". |
| P16 | **Yayımlanmamış katalog ayrı bir izin ve ayrı bir rota.** `CATALOG_READ` + `GET /admin/categories[/:slug]`; public uçlar genişleyen hiçbir parametre okumuyor; `routing/resolve` yalnız public katalogda yürüyor; `elevated-query.ts` silindi. | §5.1. Panel erişimi, "bu hesap gelecek çeyreğin katalogunu görebilir" ile aynı cümle değil. Sınırın bir query parametresi olması, onu bir kişinin hatırlamasına bağlı kılıyordu. |
| P15 | **401 → `/login`, 403 → `/yetkisiz`.** | İzinler öncesinde ikisi aynı şeydi (yalnız SUPER_ADMIN vardı). Artık 403'ü giriş formuna yollamak bir döngüdür: kişi zaten girmiş. |

## 3. Migration H (`20260922150000_add_admin_rbac`)

Yalnız ekleme: DML yok, `ALTER COLUMN` yok, `DROP` yok. Mevcut her `SUPER_ADMIN` hesabı rolünü ve — örtük tüm
izinlere sahip olduğu için — her yeteneğini korur. Backfill yok, çünkü doğru olacak bir backfill yok: hiçbir
hesabın rol ataması hiç olmadı.

- `AdminPermission` (76 değer) ve `AdminRoleAuditAction` enum'ları
- `UserRole` += `ADMIN` (`ALTER TYPE … ADD VALUE`; aynı migration'da kullanılmaz)
- `AdminRole`, `AdminRolePermission`, `AdminRoleAssignment`, `AdminRoleAuditLog`
- Partial unique index — Prisma'nın ifade edemediği tek şey:
  `UNIQUE (userId, roleId) WHERE "revokedAt" IS NULL`

Doğrulama izole geçici DB'de (`pr0_migration_dryrun`), gerçek `taktic` DB'sine dokunulmadan:
[`2026-09-22-pr0-migration-h-dryrun.txt`](../plans/2026-09-22-pr0-migration-h-dryrun.txt) — 73 migration,
sıfır drift, partial index yerinde, enum 76 değer, üç kök yetki enum'da **yok**.

## 4. Guard katmanı

| Guard | Sorusu | Davranış |
| --- | --- | --- |
| `AuthGuard` | Oturum var mı? | Yoksa 401 |
| `AdminAccessGuard` | Bu hesap personel mi? | `SUPER_ADMIN` ⟶ geç · `ADMIN` + ≥1 canlı atama ⟶ geç · diğerleri 403 |
| `PermissionsGuard` | Bu yeteneği taşıyor mu? | `@RequiresPermission(...)` konjonktif; `SUPER_ADMIN` her zaman geçer |
| `RolesGuard` | *(korunur)* | Kök rotalar + 27 karma rota + sağlayıcı/müşteri rotaları |
| `ProviderAccessGuard` | *(değişmez)* | 21 rota; `ADMIN` eklenmedi (P10) |

`@RequiresPermissionFromStaff(...)` yalnız `PATCH /providers/:id` içindir ve kasıtlı olarak genel bir kaçış
deliği değildir: yalnız operatörlerin çağırdığı bir rota `@RequiresPermission` kullanmalıdır, çünkü orada
"personel olmayan çağıran hakkında görüş bildirmemek" yanlış cevaptır.

Reddediş mesajı eksik izni **adlandırmaz**: ne eksik olduğunu sayan bir 403, panelin haritasını çıkarmak isteyen
birine haritayı verir.

## 5. Operatör görünümü ile müşteri sahipliği ayrımı (P14)

Kod tabanında 18 yerde `role === UserRole.SUPER_ADMIN` vardı. Hepsi aynı şey değildi:

### 5.1 Katalog, bu ayrımın dışına çıkarıldı

İlk hâlde kategori görünümü `mayReachAdminPanel`'e bağlanmıştı — yani her personel hesabı DRAFT/INACTIVE
kategorileri görüyordu. Yayımlanmamış katalog ticari olarak hassastır ve "bu hesap personel" ile "bu hesap
yayımlanmamış katalogu görebilir" aynı cümle değildir. Çözüm, o iki çağrı yerini genişletmek değil,
**ayrı bir yüzey** açmak oldu (P16): `CATALOG_READ` + `/admin/categories`. Public uçlarda genişleyen mod
tamamen kaldırıldığı için `assertElevatedQueryAccess` ve `elevated-query.ts` gereksizleşti ve silindi.

Geriye kalan üç genişletme aşağıdaki tabloda; ikisi (kategori) artık listede değil.

**Personel hesabını tanıyacak şekilde genişletilenler (3):** bunlar operatörün *ne gördüğünü* belirler ve
hangi operatörün orada olabileceğine rotanın izni zaten karar vermiştir.

| Yer | Ne yapar |
| --- | --- |
| `providers.service.ts` `ensureProviderUpdateAccess` | Sahiplik kuralının operatör istisnası |
| `providers.service.ts` `updateProvider` dönüş şekli | Operatörün kaydettiği profili aynı şekilde geri görmesi |
| `providers.service.ts` `providerVisibility` | `admin` projeksiyonu |

**Dokunulmayanlar (13):** müşteri sahipliği kontrolleri (`ensureCustomerRequestAccess`,
`service-requests`, `provider-reviews`, `phone-verification`), `ProviderAccessGuard` arkasındaki görünüm
seçimleri (`credits`, `entitlements` — `ADMIN` oraya zaten ulaşamıyor), son-aktif-süper-admin koruması ve
`admin-roles` içindeki kasıtlı kontroller. Bir operasyon personelinin bir müşterinin talebini kapatması
veya onun adına işlem yapması, izin kataloğunun vereceği bir yetenek değil, ayrı bir ürün kararıdır (§12.2).

## 6. API yüzeyleri

| Rota | Koruma |
| --- | --- |
| `GET /admin/me/permissions` | `AdminAccessGuard` (izin yok — kendi yeteneklerini döner) |
| `GET /admin/permissions` | **kök** — `@Roles(SUPER_ADMIN)` |
| `GET/POST /admin/roles`, `GET/PATCH /admin/roles/:id`, `PUT /admin/roles/:id/permissions` | **kök** |
| `GET /admin/categories`, `GET /admin/categories/:slug` | `CATALOG_READ` |
| `GET/POST /admin/users/:userId/roles`, `DELETE /admin/users/:userId/roles/:roleId` | **kök** |
| 119 mevcut admin rotası | Eşleme tablosundaki izin |
| `GET /categories`, `GET /categories/:slug`, `POST /categories/routing/resolve` | **public, dar** — genişleyen parametre yok |
| `PATCH /providers/:id` | `PROVIDERS_WRITE`, yalnız personelden |
| `POST /users`, `POST /users/:id/invite-link` | **kök** |

`SUPER_ADMIN` yazan bir rota yoktur; rol değiştiren bir rota yoktur.

## 7. Admin UI

- `requireAdmin(...permissions)` — 46 çağrı, 46 sayfa. İzin yoksa `/yetkisiz`, personel değilse `/login`.
- `nav.ts` — her satır kendi iznini taşır; `filterNavGroups` boşalan grubu da düşürür. `/roles` satırı
  `superAdminOnly`, çünkü onu açacak bir izin **yok**.
- Kenar çubuğu sunucuda, `GET /admin/me/permissions` ile kurulur; `/login` de aynı layout'u kullandığı için
  `readAdminAccess` yönlendirme yapmaz, `null` döner.
- `/roles` ve `/roles/[id]`: rol listesi, oluşturma, ad/açıklama, izin matrisi (76 kutu, alana göre gruplu),
  pasifleştirme (onay kutusu zorunlu — sonucu bu ekranda görünmez).
- Kullanıcı detayında rol atama/geri alma; geri alınmış atamalar gri olarak kalır.
- Operasyon Ayarları'nda motor kartı `CAMPAIGN_ENGINE_TOGGLE` olmadan **düğmesiz** render edilir.

## 8. Test planı ve sonucu

| Dosya | Ne kanıtlar |
| --- | --- |
| `admin-rbac-route-map.spec.ts` (7) | Eşleme **çift yönlü** sözleşme: sınıflandırılmamış admin rotası **kırmızı**, ölü eşleme **kırmızı**, izin uyuşmazlığı **kırmızı**; `PermissionsGuard` olan her yerde `AdminAccessGuard`; kök rotalar rolde ve izinde değil; katalog tamamı kullanılıyor ve yalnız katalog kullanılıyor; 76 değer, üç kök yetki yok (I-1) |
| `admin-catalog-visibility.spec.ts` (11) | Public uç sekiz query yazımında da sızdırmıyor · slug ile de sızdırmıyor · müşteri/sağlayıcı/izinsiz ADMIN dar görünüm · routing walk taslağa girmiyor · izinsiz ADMIN 403, anonim 401 · `CATALOG_READ` tam katalog · atamasız `SUPER_ADMIN` örtük · yalnız okuma izniyle dört yazma da 403 · yayımlanmamış katalogu servis eden rota tam olarak iki |
| `admin-rbac-access.spec.ts` (19) | Atamasız `ADMIN` 403 · `SUPER_ADMIN` atamasız her şey · müşteri/sağlayıcı atama taşısa bile 403 · izin sınırı · revoke ve pasif rol anında etkili · `/admin/me/permissions` = guard davranışı · tüm izinli `ADMIN` kök rotalarda 403 (I-6) · `POST /users` → `ADMIN` (I-3) · davet rolü değiştirmez (I-4) · `SUPER_ADMIN` yazan rota yok (I-5) · motor anahtarı ayrı (I-8) · 13 sağlayıcı rotasında tüm izinli `ADMIN` 403 (I-7) · `PATCH /providers/:id` üç yol |

Rota haritası testi, bu PR'ın kendi kendini denetleyen parçasıdır: **eksik veya sınıflandırılmamış bir rota
testi kırar.**

## 9. Kapsam dışı

`ProviderAccessGuard`'a `ADMIN` eklemek · 27 karma rotayı değiştirmek · `SUPER_ADMIN` oluşturan/terfi ettiren
bir yüzey · izin adı üreten bir yüzey · müşteri sahipliği kontrollerini gevşetmek · `SensitiveDataAccessLog`
(CMP-006 PR-C) · beş CMP-006 izni (karşılık gelen rota yok).
