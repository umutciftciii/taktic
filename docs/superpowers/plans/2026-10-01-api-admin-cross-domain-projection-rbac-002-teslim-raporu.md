# API-ADMIN-CROSS-DOMAIN-PROJECTION-RBAC-002 — teslim raporu

- **Taban:** `main@309dbcdc`, DB 83 migration. **Migration yok**; Prisma şeması, `.env`, compose değişmedi. Backlog değişmedi.
- **Kapsam:** RBAC-001'in açık bıraktığı üç least-privilege açığı. `FINANCE_READ` ↔ `FINANCE_LEDGER_READ` iç ayrımına dokunulmadı (ayrı ürün kararı).
- **Mekanizma:** yeni izin mekanizması yok. Hepsi `apps/api/src/modules/auth/embedded-permissions.ts` → `mayEmbed()` üzerinden. Personel e-postası için iki ince yardımcı eklendi: `mayEmbedStaffEmail(user)` = `mayEmbed(user, ADMIN_USERS_READ)` ve `staffActorSelect(user)` = `{ select: { id, name, email: mayEmbedStaffEmail(user) } }`.
- **Kural (RBAC-001 ile aynı):** izin yoksa anahtar yanıtta **hiç yok** (`null`/`0`/maske değil). SUPER_ADMIN `hasPermission` ile her izni taşır → tam görünüm. Aktörün `id`/`name`'i (audit) her zaman gider; audit satırları değişmedi.

## Endpoint / alan / izin matrisi

| Endpoint (rota izni) | Alan | İzin | İzinsiz |
| --- | --- | --- | --- |
| `GET /admin/campaigns/:id/redemptions` (`CAMPAIGNS_READ`) | `items[].lot.remainingCredits` | `FINANCE_LEDGER_READ` | anahtar yok; `lot.{id,status,expiresAt}` kalır; DB'den de seçilmez |
| `GET /admin/package-refund-requests/:id` (`PACKAGE_REFUND_READ`) + aynı detayı döndüren `POST create/take/approve/reject/settlement-failed` | `supportTicket {id,subject,status,topic}` | `SUPPORT_READ` | `supportTicket` anahtarı yok; `supportTicketId` kalır |
| `GET /customers/:id/notes` (`CUSTOMER_NOTES_READ`), `POST /customers/:id/notes` | `createdBy.email` | `ADMIN_USERS_READ` | `email` yok |
| `GET /finance/summary` (`FINANCE_READ`) | `recentTransactions[].createdBy.email` | `ADMIN_USERS_READ` | 〃 |
| `GET /finance/credit-ledger` (`FINANCE_LEDGER_READ`) | `items[].createdBy.email` | `ADMIN_USERS_READ` | 〃 |
| `GET /admin/providers/:id/credits` (`FINANCE_LEDGER_READ`) | `transactions[].createdBy.email` | `ADMIN_USERS_READ` | 〃 |
| `GET /providers/:id/credits(/transactions)` (sahip sağlayıcı / SUPER_ADMIN) | `createdBy` | SUPER_ADMIN | sağlayıcıya aktör hiç gitmez (önceki gibi) |
| `GET /admin/promotion-eligibility/holds(/:eventId)`, `POST …/decision` (`PROMOTION_ELIGIBILITY_REVIEW`) | `review.decidedBy.email` | `ADMIN_USERS_READ` | `email` yok |
| `GET /admin/showcase/versions(/:id)`, `GET /admin/showcase/cards(/:id)` + approve/reject/suspend/unsuspend yanıtları | `review.reviewedBy.email` (sürüm, kartın canlı/taslak/reddedilen sürümü, kart geçmişi) | `ADMIN_USERS_READ` | `email` yok |
| `GET /providers/:id/showcase/cards(/:cardId)` ve sağlayıcı kart yazma yanıtları | `review.reviewedBy.email` | — | **yeni açık kapatıldı:** personel e-postası sağlayıcı paneline gidiyordu; artık hiç gitmez |
| `GET /service-requests/:id` (`REQUESTS_READ`) | `cancellation.actor.email` | personel aktör → `ADMIN_USERS_READ`; müşteri aktör → `CUSTOMERS_READ` (RBAC-001 hesap bloğu kuralı) | `email` yok; `id/name/role` kalır |

Değişmeyenler (zaten e-postasız): kampanya `createdBy/actor/revokedBy`, iade `createdBy/reviewStartedBy/approvedBy/…` ve olay aktörleri, vitrin yerleşim iptal aktörü, şirket ayarları `updatedBy`. `admin-roles` üye listesi SUPER_ADMIN'e özel (`requireSuperAdmin`), `users` modülü `ADMIN_USERS_READ`'in kendisi.

## Arama / filtre ile dolaylı sızıntı

- Personel e-postası/adı üzerinde arama, filtre veya sıralama yapan admin rotası yok (`createdBy`/`actor`/`decidedBy`/`reviewedBy` üzerinde `where`/`orderBy` taraması boş). Kredi defteri `q` yalnız gerekçe + işletme adı (+ `PROVIDERS_READ` ile iletişim) arar.
- Redemption listesi yalnız `limit/cursor` alır; bakiyeye göre filtre/sıralama yok.
- İade listesi yalnız `status` filtreler; destek talebi içeriğine göre arama yok.
- Admin kredi paneli (`transactions-panel.tsx`) istemci tarafı aramada e-postayı yalnız yanıtta varsa kullanır.

## UI uyarlamaları (admin)

- `lib/api.ts`, `lib/business-registration.ts`: ilgili tiplerde `email?`, `remainingCredits?`, `supportTicket?` opsiyonel.
- Kampanya detayı redemption tablosu: "kalan N" yalnız alan geldiyse; geri alma diyaloğu bakiye yoksa rakamsız genel cümleyi kullanır (mevcut `null` dalı).
- İade detayı: `supportTicket` gelmezse "Bağlı — içeriği destek okuma yetkisiyle görünür" (`package-refund-ticket-hidden`); geldiyse önceki gibi konu + `/support/:id` bağlantısı. Kullanılmayan `can` kaldırıldı.
- Defter/aktör hücreleri (`LedgerActorCell`, kredi paneli, müşteri notu, uygunluk, vitrin inceleme, talep iptali) zaten `name ?? email ?? id` kalıbında; e-posta yoksa ad (yoksa id) gösterilir. Vitrin inceleme yedeğine `id` eklendi.
- Web: `reviewedBy` tipinden `email` kaldırıldı (sağlayıcıya gelmiyor; web bunu hiç çizmiyordu).

## Test

- **API yeni:** `apps/api/test/admin-cross-domain-projection-002.spec.ts` — 32 test: üç endpoint ailesi için tek-izinli ADMIN (izinsiz/izinli), SUPER_ADMIN, JSON'da anahtar ve değer yokluğu, yazma yanıtları (`take`, not oluşturma), sağlayıcı paneline e-posta gitmemesi, `FINANCE_READ`'in bakiyeyi açmadığı, `FINANCE_LEDGER_READ` tek başına redemption rotasını açmadığı (403).
- **API tam süit:** 185 dosya / 4106 test geçti.
- **Admin:** typecheck, lint, 28 dosya / 572 unit test geçti; `next build` geçti. API `tsc` build, web typecheck geçti.
- **E2E (Chromium + WebKit):** `e2e/tests/admin-cross-domain-projection.spec.ts`'e üç senaryo (lot bakiyesi, iade destek bloğu, defter operatör e-postası) — dosya 14/14 iki tarayıcıda geçti. İade fikstürü satın alma koşul kanıtını API'nin kanonik metninden üretir (`purchase-terms.documents/snapshot`, yan etkisiz modüller).

## Yeni açıklar / notlar

- **Kapatıldı (kapsam içi, beklenmedik):** vitrin projeksiyonu inceleyen personelin e-postasını sağlayıcı paneline de gönderiyordu.
- **Not:** redemption `lot.status` (ör. tükendi) ve geri alınmış satırdaki `spentAtRevoke/revokedCredits` bakiye hakkında dolaylı bilgi verir. İkisi de kampanyanın kendi kaydı (durum/geri alma denetimi) sayıldı ve dokunulmadı; ürün kararı gerekirse ayrı iş.
- **Not:** sağlayıcı paneli inceleyen personelin **adını** görmeye devam eder (bu iş yalnız e-postayı kapsar).
