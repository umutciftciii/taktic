# API-ADMIN-CROSS-DOMAIN-PROJECTION-RBAC-002 — teslim raporu

- **Taban:** `main@309dbcdc`, DB 83 migration. **Migration yok**; Prisma şeması, `.env`, compose değişmedi. Backlog değişmedi.
- **Kapsam:** RBAC-001'in açık bıraktığı üç least-privilege açığı + iki ürün kararı (ikinci tur, aynı PR):
  1. **Finans iç ayrımı:** `FINANCE_READ` = genel/aggregate finans görünümü; sağlayıcı bazlı bakiye ve ledger satırları = `FINANCE_LEDGER_READ`. İkisi birlikteyken görünüm öncekiyle aynı.
  2. **Sağlayıcı panelinde inceleyen personel:** sağlayıcıya personelin adı/e-postası/kimliği gitmez; karar, not, tarih kalır. Admin tarafı mevcut izin modeliyle aynı.
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
| `GET /providers/:id/showcase/cards(/:cardId)` ve sağlayıcı kart yazma yanıtları | `review.reviewedBy` (id, ad, e-posta) | — | **sağlayıcıya hiç gitmez** (ürün kararı); `review {id, decision, note, createdAt}` kalır |
| `GET /finance/summary` (`FINANCE_READ`) | `recentTransactions` | `FINANCE_LEDGER_READ` | anahtar yok, sorgu yapılmaz; `revenue`, `packagePurchases`, `credits` (toplam aktif bakiye dahil), `recentPurchases` kalır |
| `GET /finance/providers` (`FINANCE_READ`) | sağlayıcının kredi defterinden okunan her alan: `currentBalance`, `totalCreditsPurchased`, `totalCreditsSpent`, `totalCreditsRefunded`, `totalCreditsAdminGranted`, `totalCreditsAdminDeducted`, `manualNetCredits`, `totalCreditsAdjusted`, `lastTransactionAt` | `FINANCE_LEDGER_READ` | anahtarların hepsi yok; üç ledger sorgusu (tür toplamları, son hareket, bakiye) hiç çalışmaz. Bu alanlara `sortBy` **403 `INSUFFICIENT_PERMISSION`**; varsayılan sıralama izinsizde `lastPaymentAt` (izinliyken `lastTransactionAt`). Paket ödemeleri `totalPaidAmount`, `lastPaymentAt` `FINANCE_READ` ile kalır. `q` yalnız işletme adı (+ `PROVIDERS_READ` ile iletişim) arar, kredi filtresi yok |
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
- Web: `ShowcaseCardReviewRecord.reviewedBy` tipten kaldırıldı (sağlayıcıya gelmiyor; web inceleyeni hiç çizmiyordu, bu yüzden "TakTick inceleme ekibi" metnine gerek olmadı, sahte aktör üretilmedi).
- Finans özeti: "Son kredi hareketleri" kartı yalnız `recentTransactions` geldiyse çizilir; KPI'lar değişmedi.
- İşletme bakiyeleri: kredi defteri sütunları (Bakiye, Satın alınan/Harcanan/İade edilen kredi, Manuel net, Son hareket) ve bunların sıralama seçenekleri yalnız `FINANCE_LEDGER_READ` ile; izinsizde tablo İşletme/Durum/Toplam ödeme/Son ödeme'dir. Elle yazılmış ledger `sortBy` izinsizde varsayılana (`lastPaymentAt`) düşer, API'ye gönderilmez (403 ekranı yok).

## Test

- **API yeni:** `apps/api/test/admin-cross-domain-projection-002.spec.ts` — 32 test: üç endpoint ailesi için tek-izinli ADMIN (izinsiz/izinli), SUPER_ADMIN, JSON'da anahtar ve değer yokluğu, yazma yanıtları (`take`, not oluşturma), sağlayıcı paneline e-posta gitmemesi, `FINANCE_READ`'in bakiyeyi açmadığı, `FINANCE_LEDGER_READ` tek başına redemption rotasını açmadığı (403).
- **API tam süit:** 185 dosya / 4106 test geçti.
- **Admin:** typecheck, lint, 28 dosya / 572 unit test geçti; `next build` geçti. API `tsc` build, web typecheck geçti.
- **E2E (Chromium + WebKit):** `e2e/tests/admin-cross-domain-projection.spec.ts`'e üç senaryo (lot bakiyesi, iade destek bloğu, defter operatör e-postası) — dosya 14/14 iki tarayıcıda geçti. İade fikstürü satın alma koşul kanıtını API'nin kanonik metninden üretir (`purchase-terms.documents/snapshot`, yan etkisiz modüller).

## Yeni açıklar / notlar

- **Kapatıldı (kapsam içi, beklenmedik):** vitrin projeksiyonu inceleyen personelin e-postasını sağlayıcı paneline de gönderiyordu.
- **Karar (değişmedi):** redemption `lot.status`, `spentAtRevoke`, `revokedCredits` kampanya yaşam döngüsü/audit verisi olarak kalır.
- **Karar (3. tur):** `FINANCE_READ` yalnız genel/aggregate görünüm; sağlayıcı bazlı tüm kredi/bakiye ayrıntıları `FINANCE_LEDGER_READ`. Sistem geneli KPI'lar (`/finance/summary` `credits.*`, `/finance/analytics`) `FINANCE_READ` ile kalır. `lastTransactionAt` sağlayıcının son kredi hareketi zamanı olduğu için ledger tarafına alındı.
