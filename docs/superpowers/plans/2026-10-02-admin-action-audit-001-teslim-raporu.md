# ADMIN-ACTION-AUDIT-001 — Birleşik Audit Paketi · Teslim raporu

- **Taban:** main `cdef15a1587e774b10d951c21aa54c5d2a6548a3`
- **Branch:** `claude/audit-package-admin-1f1d66` (tek branch, tek PR)
- **Migration:** **83 → 84** (`20261002120000_add_admin_action_audits`, yalnız ekleme)
- **Kapsam:** rol audit okuması · personel / müşteri / sağlayıcı durum audit'i · şirket ayarları alan audit'i ·
  katalog (kategori, kredi paketi, vitrin paketi) audit'i · davet iptal eden aktör

## 1. Kanonik tasarım (H)

Mevcut modeller incelendi: `AdminRoleAuditLog`, `CampaignAuditLog`, `OperationsSettingsChange`,
`ProviderReviewModeration`, `ShowcasePlacementSuspension/Cancellation`, `PackageRefundRequestEvent`,
`ProviderBusinessRegistrationChange`, `SupportTicketStatusChange`.

**Karar:** tek bir genel `AdminActionAudit` tablosu yok. Her domain kendi olgusunu tutar, okuma tarafı ise tek bir
şekle projekte eder.

- **Yazım tarafı** domain tablolarıdır. Her biri yalnız kendi gerçeğini tutar: bir durum çifti ya da alan diff'i.
- **Okuma tarafı** tek bir `AdminAuditEntry` DTO'sudur (`apps/api/src/common/admin-audit.ts`):

  ```
  { id, domain, action, actor{id,name,email?}|null, target{type,id,label?}|null,
    changes[{field,from,to}], reason|null, note?, targetUser?, payload?, createdAt }
  ```

  Sayfa şekli: `{ items, total, page, pageSize (≤50), hasNextPage }`. Sıralama `createdAt desc, id desc`.
- **Ekranlar** tek bir `AuditTimeline` bileşeni (`apps/admin/components/audit-timeline.tsx`) ile çizilir.
- **Rol olayları kopyalanmadı.** `AdminRoleAuditLog` olduğu gibi okunur ve yazım davranışı değişmedi.

| Domain | Kaynak tablo | Yeni mi? |
| --- | --- | --- |
| A Rol | `AdminRoleAuditLog` | Hayır (yalnız okuma eklendi) |
| B Personel durumu | `AccountStatusChange` (`userRole` = ADMIN / SUPER_ADMIN) | Evet |
| C Müşteri durumu | `AccountStatusChange` (`userRole` = CUSTOMER) | Evet (B ile aynı tablo: tek olgu `User.isActive`) |
| D Sağlayıcı durumu | `ProviderStatusChange` | Evet |
| E Şirket ayarları | `CompanySettingsChange` (`changes` jsonb dizi) | Evet |
| F Katalog | `CatalogAuditLog` (`entityType` CATEGORY / CREDIT_PACKAGE / SHOWCASE_PACKAGE) | Evet |
| G Davet iptali | `ProviderInviteToken.revokedById` (nullable) | Yeni kolon |

**Değişmezlik.** Yeni dört tablonun her biri append-only'dir: mevcut `cmp006_append_only_fn` tetikleyicisi UPDATE ve
DELETE'i reddeder. Buna ek CHECK'ler var:

- `fromActive <> toActive` ve `fromStatus <> toStatus`: no-op satır yazılamaz.
- `changes`, boş olmayan bir jsonb dizidir.
- `revokedById IS NULL OR revokedAt IS NOT NULL`.

## 2. Endpoint + izin matrisi

Yeni izin yok; katalogdaki izin sayısı **84** olarak kalır. Her okuma, verinin kendi okuma izniyle açılır. Aktör
e-postası `staffActorSelect` kuralına uyar: yalnız `ADMIN_USERS_READ` ile gelir, yoksa anahtar hiç yoktur.

| Metot | Yol | İzin |
| --- | --- | --- |
| GET | `/admin/roles/:id/audit` | KÖK (`@Roles(SUPER_ADMIN)`, `ROOT_ONLY_ROUTES`) |
| GET | `/admin/users/:userId/role-audit` | KÖK |
| GET | `/users/:id/status-history` | `ADMIN_USERS_READ` (yalnız personel hesabı; değilse 404) |
| GET | `/customers/:id/status-history` | `CUSTOMERS_READ` |
| GET | `/providers/:providerId/status-history` | `PROVIDERS_READ_DETAIL` |
| GET | `/company-settings/history` | `COMPANY_SETTINGS_READ` |
| GET | `/admin/categories/:slug/history` | `CATALOG_READ` |
| GET | `/admin/offer-packages/:id/history` | `CREDIT_PACKAGES_READ` |
| GET | `/admin/showcase/packages/:packageId/history` | `SHOWCASE_PACKAGES_READ` |

Tümü `route-permission-map.ts` dosyasına eklendi; `admin-rbac-route-map.spec.ts` çift yönlü olarak geçiyor.
`docs/superpowers/plans/2026-09-22-pr0-route-permission-map.md` §16 güncellendi.
`admin-catalog-visibility.spec.ts`, CATALOG_READ ile açılan rota kümesine `:slug/history` eklenecek şekilde bilinçli
olarak güncellendi.

**Yazım rotalarına aktör eklendi** (yalnız `@CurrentUser`; guard/izin değişmedi):

- `PATCH /customers/:id/status`
- `PATCH /providers/:id/status`
- `PATCH /categories/:id/status`
- `PATCH /credit-packages/:id/status`
- `POST` ve `PATCH /admin/showcase/packages[/:id]`
- `POST .../provider-invites/:inviteId/revoke`

## 3. Domain bazında yazılan olaylar

| Domain | Yol | Olay | Ne yazılır | Yazılmaz |
| --- | --- | --- | --- | --- |
| B | `PATCH /users/:id/status` | ACTIVATED / DEACTIVATED | userId, userRole, from → to, actorId, reason=null | no-op, 403 SA hedef, 409 kendini pasifleştirme, 409 son aktif SA |
| C | `PATCH /customers/:id/status` | ACTIVATED / DEACTIVATED | aynı | no-op (200 döner, satır yok) |
| D | `PATCH /providers/:id/status` | STATUS_CHANGED | from → to (transaction içinde okunur), rejectionReason → `reason`, moderationNote → `note` | aynı durumu yeniden kaydetme (yalnız not değişse de), 400 gerekçesiz ret |
| E | `PUT /company-settings` | UPDATED | yalnız değişen alanlar: legalName, supportEmail, postalAddress | no-op kayıt (satır **ve** `updatedBy` değişmez) |
| F kategori | `POST /categories`, `PATCH /categories/:id`, `PATCH /categories/:id/status` | CREATED / UPDATED / STATUS_CHANGED | name, slug, kind, parent{id,name}, status, offerCreditCost, unlimitedPackageEligible, providerEnrollmentOpen, description, sortOrder, iconKey, imageUrl, coverImageUrl | stale echo, 403 delta reddi |
| F kredi paketi | `POST /credit-packages`, `PATCH /credit-packages/:id`, `PATCH .../status` | aynı | name, slug, type, priceAmount, currency, creditAmount, quotaCredits, periodDays, dailyOfferLimit, scopeCategories[{id,name}], isActive, description, sortOrder | no-op |
| F vitrin paketi | `POST` ve `PATCH /admin/showcase/packages` | aynı | name, slug, priceAmount, currency, durationDays, allowedCardKind, maxAreas, requiresAdminApproval, activationWindowDays, isActive, description, sortOrder | no-op |
| G | `POST .../revoke` | — | `revokedAt` ile aynı ifadede `revokedById` | zaten iptal veya kullanılmış davet |

Ek notlar:

- **STATUS_CHANGED** yalnız durum alanı (`status` ya da `isActive`) değiştiğinde yazılır. Başka bir alan da
  değiştiyse kayıt UPDATED olur.
- **Eski → yeni değerler** her zaman yazım transaction'ı içinde okunan DB değerlerinden gelir.
- **Referanslar** (üst kategori, paket kapsamı) yazım anındaki adıyla saklanır. Karşılaştırma id ile yapılır;
  yalnızca ad değişikliği sahte bir diff üretmez.
- **Katalog `entityId` FK'sızdır.** Kategori hard-delete'i ne engellenir ne de geçmişi siler; bu durum test
  edildi.
- **Mevcut davranışlar korundu:**
  - Onay kampanya hook'u
  - Claim token iptali
  - Onay e-postası
  - Vitrin askı/geri alma
  - SUPER_ADMIN hedef guard'ı, kendini pasifleştirme, son aktif SA
  - Delta izin kuralları

  Personel ve müşteri yazımı artık eski değere koşullu (`updateMany`) ve audit satırıyla aynı transaction'da.

## 4. UI zaman çizelgeleri

| Ekran | Kart | Not |
| --- | --- | --- |
| `/roles/[id]` | "Neler oldu" (`role-history`), `?gecmisSayfa=` | Atama satırı hesabı, izin satırı eklenen/çıkarılanları, ad/açıklama satırı yalnız alan adını gösterir ("eski değer kaydedilmez") |
| `/users/[id]` | "Neler oldu" (`user-status-history`, `?durumSayfa=`) + "Rol geçmişi" (`user-role-history`, `?rolSayfa=`, yalnız süper admin) | İki kaynak iki ayrı kartta; sahte birleştirme yok |
| `/customers/[id]` | Yeni sekme `?tab=gecmis` (`customer-status-history`) | PII projeksiyonu değişmedi |
| `/providers/[id]` | Yeni sekme `?tab=gecmis` (`provider-status-history`) | Yalnız durum geçişleri; e-posta/kampanya olayı yok |
| `/company-settings` | "Son değişiklikler" (`company-settings-history`) | Alan · eski · yeni · yapan · zaman |
| `/categories/[slug]?tab=gecmis` | Kategori audit'i (`category-activity`) + davet geçmişi (`category-invite-activity`) | Zaman damgasından türetilen "Son güncellendi" ve soru satırları kaldırıldı |
| `/credit-packages/[id]?tab=gecmis` | `credit-package-activity` | `recordLifecycleEntries` / `NO_CHANGE_HISTORY_NOTE` kaldırıldı |
| `/showcase/packages/[id]?tab=gecmis` | `showcase-package-activity` | aynı |
| Davet listesi | "iptal: … · iptal eden: X" | Eski satırlarda "Bilinmiyor" |

## 5. No-op / aktör-null / silinmiş aktör

- **No-op:** hiçbir domain satır yazmaz. Bu, servis kuralıyla ve DB CHECK'i (durum çiftleri, boş olmayan diff)
  ile güvenceye alınmıştır.
- **Aktör-null:** yeni tablolarda `actorId NOT NULL`. Şirket ayarları kaydı oturumsuz gelirse 403 döner. NULL
  yalnız `ProviderInviteToken.revokedById` kolonunda olur; bu da kolondan önce iptal edilmiş eski davetlerdir. UI
  bunlar için "Bilinmiyor" gösterir ve backfill yapılmaz.
- **Silinmiş aktör:** FK'ler `Restrict` olduğu için, audit satırı olan bir hesap silinemez (uygulamada kullanıcı
  hard-delete yolu yok). UI yine de savunmalıdır:
  - aktör yoksa "Bilinmiyor";
  - adı boşsa e-posta;
  - o da yoksa "Hesap #id";
  - rol veya hedef adı yoksa `#id`.
- **Sahte geçmiş yok:** migration öncesi değişiklikler kaydedilmemiştir. Her kart dipnotta bunu söyler
  (`AUDIT_SINCE_NOTE`).

## 6. Migration güvenliği (I)

1. **Şema diff'i.** `prisma migrate diff --from-schema-datamodel (HEAD şeması) --to-schema-datamodel` ile
   üretildi. Shadow DB kullanılmadı; aktif ya da paylaşılan DB'ye bağlanılmadı.
2. **Ek SQL.** CHECK'ler ve append-only tetikleyiciler eklendi. Bunlar mevcut `cmp006_append_only_fn`
   fonksiyonunu yeniden kullanır.
3. **İzole doğrulama.** Boş `taktic_audit001_verify` DB'sinde `migrate deploy` ile 84/84 uygulandı ve
   `migrate diff --from-url` sonucu "No difference detected" oldu.
4. **Yedek.** Aktif yerel DB'nin dump'ı alındı:
   `~/Backups/taktic-pre-admin-action-audit-001-20261002-215421.dump`, yanında `.sha256`.
5. **Prova.** Dump `taktic_audit001_rehearsal` DB'sine geri yüklendi (83 migration) ve `migrate deploy` ile 84'e
   çıkarıldı. Veri parmak izi (tablo başına satır sayısı + içerik md5'i) öncesi ve sonrası **birebir aynı**. Yalnız
   4 yeni boş tablo eklendi. Şema farkı yok. `ProviderInviteToken` iptalli satır sayısı 0 olduğu için
   `revokedById` dolu satır da 0.
6. **Temizlik.** Prova ve doğrulama DB'leri silindi. **Aktif yerel `taktic` DB'si 83'te kaldı**: proje kuralı
   gereği yerel eşitleme (migrate deploy + yalnız api/admin recreate) merge sonrasında yapılır.

## 7. Ara hedefli testler

- **API:**
  - `admin-action-audit.spec.ts`: 14/14 (A–G; append-only, 403/404/400, sayfalama, e-posta projeksiyonu).
  - `admin-audit-diff.spec.ts`: 5/5.
  - Rota haritası, RBAC erişimi ve yıkıcı onay: 62/62.
  - Domain spec'leri (invite-links, providers-access, showcase-package-catalog, offer-package-access,
    status-permission-delta, taxonomy, email-branding, cross-domain-projection ×2, provider-claim,
    transactional-email-events, placement-lifecycle, campaign-engine-hooks, lifecycle-confirmation-guards,
    category-expansion, catalog-visibility, placement-cancellation-audit): 487/487. Bunun içinde, bilinçli rota
    güncellemesinden sonra yeniden koşan catalog-visibility de var.
- **Admin unit:**
  - `detail-screens`: 19/19.
  - system / access-boundaries / catalog / people-support / destructive / paket-b / confirmation-proof /
    shared-components / lifecycle: 640/640.
- **E2E (Chromium, dar):** `admin-action-audit` (4), `admin-catalog-screens` (3), `admin-showcase-review-screens`
  (6): 13/13.

## 8. FINAL regresyon (1 kez)

| Adım | Sonuç |
| --- | --- |
| typecheck api / admin / web / e2e | 0 / 0 / 0 / 0 |
| lint | 0 |
| build api / admin / web | 0 |
| API tam suite | 189 dosya, **4179/4180**. Tek hata `status-transition-guards.spec.ts` içindeki `TRUNCATE` deadlock (40P01, `resetDatabase`). Bu, bilinen ve koddan bağımsız bir flake; spec tek başına yeniden koşunca 72/72 geçti. |
| Admin unit tam | 34 dosya, **974/974** |
| Chromium tam E2E | **479 geçti, 4 düştü**. Dördü de aynı kök neden: `admin-cross-domain-projection` ×2 ve `admin-people-support-screens` ×2, müşteri ve sağlayıcı sekme listesini birebir sabitliyordu ve yeni "Neler oldu" sekmesi yoktu. Beklentiler güncellendi (aynı testteki tam liste dahil); iki spec yeniden koşunca **17/17**. |
| WebKit seçili | system-screens, people-support, catalog, showcase-review, rbac-permissions, action-audit, lifecycle, destructive(+paket-a), paket-b, route-scan: **77 geçti, 2 düştü** (aynı sekme listesi nedeni). Düzeltmeden sonra WebKit'te people-support + cross-domain-projection **17/17**. |

`admin-action-audit` WebKit `testMatch` listesine eklendi.

## 9. Kapsam dışı kalan audit borçları

- Kategori **soru** düzenlemeleri, router kuralları ve koşullar audit edilmiyor. Kategori sekmesi bunu söylüyor.
- Kategori **hard-delete** için bir DELETED olayı yok. Silinen kaydın geçmişi id ile okunabilir halde kalır ama UI
  yolu yok.
- `AdminRoleAuditLog` için iki eksik var:
  - append-only tetikleyicisi yok (bir test fikstürü satır siliyor; yazım davranışına dokunulmadı);
  - `ROLE_UPDATED` yalnız alan adını tutuyor, eski ve yeni değeri tutmuyor.
- Personel ve müşteri durum değişikliğinde **gerekçe** toplanmıyor (kolon var, NULL). Bunun için bir ürün kararı
  gerekiyor.
- Sağlayıcının kendi başvurusu ve davet ile başvuru gibi admin dışı yollar durum audit'i yazmıyor; kapsam yalnız
  admin geçişleriydi.
- `prisma/import-*` betikleriyle katalog içe aktarma audit yazmıyor (admin dışı yol).
- Genel audit akışı (ADMIN-GLOBAL-AUDIT-FEED-001), zamanlayıcı koşu kalıcılığı ve bildirim yeniden deneme audit'i
  kapsam dışında bırakıldı.
- Müşteri aktivasyon linki ve davet *üretimi* audit'i bu pakette yok; yalnız durum yaşam döngüsü ele alındı.
