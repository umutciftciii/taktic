# OBS-ALERT-002 — Admin'den yönetilen alarm e-posta alıcıları: Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operasyon alarmı e-posta alıcılarını `.env` yerine admin panelinden, şifreli ve denetlenebilir biçimde yönetmek; OBS-ALERT-001 davranışını geçiş tamamlanana kadar birebir korumak.

**Architecture:** Alıcılar `OpsAlertRecipient` tablosunda AES-256-GCM ile şifreli, HMAC ile tekil tutulur; her e-posta teslimatı değişmez `recipientId` ile bir alıcıya bağlanır ve adres gönderim anında yalnız o satırdan çözülür. Yönlendirme modu (`ENV_LEGACY` | `MANAGED`) DB'deki tek satırdır; evaluator onu kuyruğa yazdığı transaction içinde okur, tüm instance'lar aynı kararı verir. Geçiş ve geri dönüş, sayıları önceden gösteren bir önizleme + o sayılara bağlı onayla yapılır.

**Tech Stack:** NestJS 11 + Prisma (PostgreSQL 16.6), Next.js admin (server actions + ConfirmGate), Vitest, Playwright, Node `crypto` (AES-256-GCM, HMAC-SHA256).

**Spec:** Bu dosyanın §0 bölümü — 2026-11-01 oturumunda onaylanan "OBS-ALERT-002 v2" mimarisi ve kullanıcının dokuz düzeltmesi.

---

## 0. Onaylanan tasarım (spec)

1. Alıcılar admin > Sistem Sağlığı > Operasyon Alarmları > **Bildirim Ayarları** altında yönetilir; ekle / etiket+tercih düzenle / pasifleştir / sil.
2. Alıcı başına `notifyWarning`, `notifyCritical`, `notifyRecovery`. Düzelme yalnız o alarm için daha önce bilgilendirilmiş (SENT/SENDING satırı olan) ve hâlâ ACTIVE alıcıya gider.
3. Adres AES-256-GCM (AAD = `ops-alert-recipient:<id>`), kimlik/tekilleştirme HMAC-SHA256. İki ayrı anahtar, keyring + sürüm.
4. Teslimat ↔ alıcı bağı değişmez `recipientId`. **Adres değiştirilemez**; "adresi değiştir" = yeni alıcı + eskisini sil, tek transaction.
5. Silme = soft delete + crypto-shred (şifreli metin ve HMAC NULL). Silinmiş/pasif/tercihi kapalı alıcıya bekleyen teslimat CANCELLED olur, başka adrese asla gitmez.
6. API yanıtlarında adres varsayılan maskeli (`maskedAddress`); tam adres ayrı yetki + ConfirmGate + her gösterimde audit. Loglarda alıcı adresi hiçbir biçimde (maskeli dahil) yer almaz.
7. Ayrı RBAC yetkileri; append-only audit tablosu.
8. `ENV_LEGACY` (varsayılan) modunda OBS-ALERT-001 yönlendirme, kanal, zamanlama ve retry davranışı değişmez. Tek bilinçli fark: madde 12.
9. `ENV_LEGACY → MANAGED` geçişi SUPER_ADMIN, önizleme + sayı-bağlı onay; env adresinin HMAC'ı bir ACTIVE alıcıyla eşleşiyorsa bekleyen eski satırlar o alıcıya bağlanır, eski SENT satırlar o alıcı için "bilgilendirilmiş" sayılır. Geri dönüş (`MANAGED → ENV_LEGACY`) aynı önizleme/onay düzeniyle.
10. **Son kritik e-posta alıcısı** (ACTIVE ∧ notifyCritical) silme/pasifleştirme/kritik kapatma: Telegram olsa bile açık uyarı + ConfirmGate. **Production'da son etkin kanal** (Telegram yok ∧ son kritik e-posta alıcısı) kaldırılamaz — API 409, onayla da aşılamaz.
11. Telegram değişmez. Alıcı sınırı 10.
12. **noticeSnapshot:** Bildirim içeriği (e-posta template verisi + Telegram metni) kuyruğa ekleme anında satıra donar; her retry aynı içerikle ve aynı idempotency anahtarıyla gider. Migration öncesi satırlar (snapshot NULL) eskisi gibi canlı oluşturulur.
13. Rollback'te iptal edilecek teslimatlar önce **sayı ve durum bazında raporlanır**; iptal yalnız operatör o sayıları onaylayarak (sayılar değişmişse reddedilir) çalıştırır.
14. Anahtar yedekleme, geri yükleme ve rotasyon prosedürleri runbook'ta.

## Global Constraints

- Production, staging, UAT, gerçek `.env` dosyaları ve backlog dosyalarına dokunulmaz; deploy yok. `.env.example` yalnız yorum/şablon olarak güncellenir (OBS-ALERT-001 emsali).
- Alıcı sınırı: `OPS_ALERT_RECIPIENT_LIMIT = 10`.
- Env adları: `OPS_ALERT_RECIPIENT_ENC_KEYS` (`v<n>:<base64 32 bayt>` virgülle), `OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE` (`v<n>`), `OPS_ALERT_RECIPIENT_HMAC_KEY` (≥ 32 karakter), `OPS_ALERT_RECIPIENT_HMAC_KEY_VERSION` (1–1000, varsayılan 1).
- Anahtarlar: `NODE_ENV=test` veya `APP_ENVIRONMENT=local` → yayımlanmış geliştirme anahtarları; staging/production/belirsiz → zorunlu, geliştirme anahtarı reddedilir (`promotion-fingerprint.ts` kalıbı). Boot mesajları değişken adını söyler, değeri asla.
- HMAC girdisi: `"ops-alert-recipient:v1:" + trim(lowercase(adres))`. Adres ≤ 254 karakter, `isWellFormedEmail`, ad-içeren biçim reddedilir.
- Maskeleme: mevcut `maskEmail` (`u***@icloud.com`).
- Etiket: 1–80 karakter, trim.
- Idempotency anahtarı değişmez: `taktic-ops-alert-${deliveryId}`.
- Yeni hata kodları (TEXT, enum değil): `RECIPIENT_REMOVED`, `RECIPIENT_PAUSED`, `PREFERENCE_OFF`, `DECRYPT_FAILED`, `LEGACY_AFTER_CUTOVER`, `ROUTING_REVERTED`, `ROLLED_BACK`.
- Yanıt projeksiyonları açık `select` allowlist (bkz. feedback "Yanıt projeksiyonu allowlist"); tam HMAC, şifreli metin, nonce asla yanıtta yok.
- Migration SQL `prisma migrate diff --from-schema-datamodel <HEAD şeması>` ile üretilir; `prisma format` kullanılmaz.
- Typecheck paket script'iyle: `pnpm --filter @taktic/api typecheck` (tsconfig.test.json dahil).
- Kullanıcıya dönük metin Türkçe; kod/yorum İngilizce, çevredeki yoğunlukta.

## Review Focus

1. **Eşzamanlı 11. alıcı:** iki instance aynı anda 10. ve 11. alıcıyı eklerse biri 409 almalı → Task A3 testi `rejects the 11th recipient when two creates race`.
2. **Gönderim sırasında silme:** worker satırı claim etmişken alıcı silinirse o tek mektup aynı adrese gidebilir, retry asla → Task A6 testi `a retry after deletion cannot decrypt and is cancelled`.
3. **Anahtar keyring'den erken çıkarılırsa:** eski sürümle şifreli alıcıya gönderim `DECRYPT_FAILED` ile ABANDONED, başka alıcıya/env'e düşmez; sağlık ekranı sürüm dağılımını gösterir → Task A6 + A8.
4. **Geçiş önizlemesi ile onay arasında yeni eski-satır doğarsa:** onay 409 `COUNTS_CHANGED` → Task A7 testi `cutover refuses when legacy counts changed since preview`.
5. **Production'da Telegram sonradan kaldırılırsa (env), son kritik alıcı korumasının taban çizgisi:** koruma Telegram durumunu her istekte config'ten okur, önbelleğe almaz → Task A4 testi `production guard reads telegram status per request`.

---

## Dosya haritası

### PR-A (backend) — yeni dosyalar `apps/api/src/modules/ops-alerts/` altında

| Dosya | Sorumluluk |
|---|---|
| `recipient-crypto.config.ts` | Keyring/HMAC env okuma, ortam kuralları, `assertOpsAlertRecipientCryptoConfig` |
| `recipient-crypto.ts` | `encryptAddress`, `decryptAddress`, `addressHmac`, `normalizeAddress` |
| `ops-alert-recipients.service.ts` | CRUD, sınır, tekilleştirme, son-kanal koruması, audit yazımı |
| `ops-alert-recipients.controller.ts` + `dto/ops-alert-recipient.dto.ts` | `/ops-alerts/recipients*` uç noktaları |
| `ops-alert-routing.service.ts` | Mod okuma, geçiş/geri dönüş önizleme+uygulama, env içe aktarma |
| `ops-alert-routing.controller.ts` | `/ops-alerts/routing*` uç noktaları |
| `ops-alert-recipient-guard.ts` | Saf fonksiyon: son kritik alıcı / son etkin kanal kararı |
| `ops-alert-recipient.audit.ts` | Audit satırı allowlist'i + `AdminAuditEntry` projeksiyonu |
| `ops-alert-key-rotation.service.ts` | `rewrap` (şifreleme) ve `rehash` (HMAC) |

Değişen: `ops-alert-delivery.worker.ts`, `ops-alert-evaluator.service.ts`, `ops-alert.rules.ts`, `ops-alert.report.ts`, `ops-alerts.module.ts`, `notifications/notification.port.ts`, `notifications/resend-notification.adapter.ts`, `notifications/console-notification.adapter.ts`, `notifications/file-outbox-notification.adapter.ts`, `notifications/templates/transactional-templates.ts`, `auth/admin-permissions.ts`, `auth/route-permission-map.ts`, `boot-config.ts`, `common/admin-audit.ts` (domain `OPS_ALERT_RECIPIENT`), `prisma/schema.prisma`, yeni migration `prisma/migrations/20261102090000_add_ops_alert_recipients/migration.sql`, `scripts/ops/runtime-contract.mjs` (+ test), `scripts/ops/compose-security.mjs`, `docker-compose.yml`, `docker-compose.prod.yml`, `.env.example`, `docs/ops/ops-alerts.md`, yeni `docs/ops/ops-alert-recipient-keys.md`, yeni `scripts/ops/obs-alert-002-rollback-report.sql`, `scripts/ops/obs-alert-002-rollback-cancel.sql`, `scripts/ops/obs-alert-002-rollback.md`.

Testler (`apps/api/test/`): yeni `ops-alert-recipient-crypto.spec.ts`, `ops-alert-recipients.spec.ts`, `ops-alert-managed-delivery.spec.ts`, `ops-alert-routing.spec.ts`, `ops-alert-privacy.spec.ts`, `ops-alert-migration.spec.ts`; değişen `ops-alerts.spec.ts`, `admin-rbac-route-map.spec.ts`, `boot-config.spec.ts`, `setup-env.ts`; `scripts/ops/runtime-contract.test.mjs`.

### PR-B (admin)

| Dosya | Sorumluluk |
|---|---|
| `apps/admin/lib/ops-alert-recipients.ts` | Tipler, Türkçe etiketler, hata kodu metinleri, `recipientDeliverySummary` |
| `apps/admin/lib/api.ts` | Yeni API çağrıları ve yetki etiketleri |
| `apps/admin/lib/confirmation-proof-keys.ts` | Yeni ConfirmGate anahtarları |
| `apps/admin/app/system-health/notification-settings/page.tsx` | Bildirim Ayarları sayfası (liste, durum şeridi, audit) |
| `apps/admin/app/system-health/notification-settings/actions.ts` | Server action'lar (proof kontrolü) |
| `apps/admin/app/system-health/notification-settings/recipient-form.tsx` | Ekle/düzenle formu (RouteDialog) |
| `apps/admin/app/system-health/notification-settings/recipient-row-actions.tsx` | Test gönder / pasifleştir / sürdür / adresi değiştir / göster / sil |
| `apps/admin/app/system-health/notification-settings/routing-panel.tsx` | İçe aktar, geçiş ve geri dönüş önizleme+onay (SUPER_ADMIN) |
| `apps/admin/app/system-health/page.tsx`, `apps/admin/lib/system-health.ts` | Bölüm bağlantısı + alıcı bazlı kanal özeti |

Testler: `apps/admin/test/ops-alert-recipients.spec.tsx`, `apps/admin/test/system-health.spec.tsx` (değişen), `e2e/tests/admin-ops-alert-recipients.spec.ts`, `e2e/tests/admin-system-health.spec.ts` + `admin-system-screens.spec.ts` (sekme/bölüm listesi sabitleri — bkz. memory "yeni sekme e2e'yi kırar").

---

## PR bağımlılıkları ve sıra

```
PR-A  (migration 108→109, mod ENV_LEGACY, davranış değişmez)
  │   merge → yerel eşitleme → (kullanıcı onayıyla) staging deploy + anahtarlar
  ▼
PR-B  (yalnız admin; migration yok; PR-A'nın API sözleşmesini tüketir)
      merge → admin recreate → staging'de içe aktar → test gönder → geçiş (kullanıcı)
```

- PR-B, PR-A **merge** olmadan açılmaz (API tipleri ve route map PR-A'da sabitlenir).
- PR-A tek başına deploy edilebilir ve görünür hiçbir şey değiştirmez: mod `ENV_LEGACY`, admin'de yeni ekran yok. API uç noktaları RBAC arkasında hazır bekler.
- PR-A staging deploy'u yeni iki sırrı gerektirir (boot kuralı). Sırları staging `.env`'e kullanıcı ekler (`read -rs` kalıbı, OBS-ALERT-001 emsali); deploy ancak preflight PASS sonrası.
- MANAGED geçişi kod olayı değil, operatör eylemidir; PR-B deploy'undan sonra, kullanıcı onayıyla.

---

## PR-A görevleri

### Task A1: Şema ve migration

**Files:**
- Modify: `prisma/schema.prisma` (OpsAlert bloğunun yanı, `AdminPermission` enum'u)
- Create: `prisma/migrations/20261102090000_add_ops_alert_recipients/migration.sql`
- Test: `apps/api/test/ops-alert-migration.spec.ts`

**Interfaces:**
- Produces: Prisma modelleri `OpsAlertRecipient`, `OpsAlertRoutingSettings`, `OpsAlertRecipientAuditLog`; enum'lar `OpsAlertRecipientStatus { ACTIVE PAUSED DELETED }`, `OpsAlertEmailRouting { ENV_LEGACY MANAGED }`, `OpsAlertRecipientAuditAction { CREATED IMPORTED_FROM_ENV LABEL_CHANGED PREFERENCES_CHANGED PAUSED RESUMED DELETED ADDRESS_REPLACED REVEALED TEST_SENT ROUTING_CUTOVER ROUTING_REVERTED REWRAPPED REHASHED }`; `OpsAlertDelivery.recipientId String?`, `OpsAlertDelivery.noticeSnapshot Json?`; `AdminPermission` yeni değerleri `OPS_ALERT_RECIPIENTS_READ`, `OPS_ALERT_RECIPIENTS_WRITE`, `OPS_ALERT_RECIPIENTS_DELETE`, `OPS_ALERT_RECIPIENTS_REVEAL`, `OPS_ALERT_RECIPIENTS_TEST`, `OPS_ALERT_ROUTING_MANAGE`.

`OpsAlertRecipient` sütunları: `id`, `channel OpsAlertChannel @default(EMAIL)`, `label`, `addressCiphertext Bytes?`, `addressNonce Bytes?`, `addressTag Bytes?`, `addressKeyId String?`, `addressHmac String?`, `addressHmacVersion Int?`, `maskedAddress String`, `notifyWarning Boolean`, `notifyCritical Boolean`, `notifyRecovery Boolean`, `status`, `version Int @default(1)`, `createdById`, `updatedById`, `deletedAt DateTime?`, `deletedById String?`, `createdAt`, `updatedAt`. Index `(status, createdAt)`. `OpsAlertDelivery` üzerinde yeni index `(recipientId, createdAt)`.

`OpsAlertRoutingSettings`: `id` (CHECK `= 'ops-alert-routing'`), `emailRouting @default(ENV_LEGACY)`, `changedAt DateTime?`, `changedById String?`, `updatedAt`. Migration tek satırı `ENV_LEGACY` ile ekler.

`OpsAlertRecipientAuditLog`: `id`, `recipientId String?` (routing olayları için NULL), `actorId String`, `action`, `before Json?`, `after Json?`, `reason String?`, `createdAt`. Index `(recipientId, createdAt)`, `(createdAt)`. `cmp006_append_only_fn` trigger'ı.

Ham SQL (Prisma ifade edemediği):
- `DROP INDEX "OpsAlertDelivery_alertId_kind_sequence_channel_key"` → yerine aynı kolonlarla `... WHERE "recipientId" IS NULL`; yeni `UNIQUE ("alertId","kind","sequence","recipientId") WHERE "recipientId" IS NOT NULL`. Sıra: önce iki yeni indeks, sonra eski DROP.
- CHECK `OpsAlertDelivery_recipient_channel_check`: `"recipientId" IS NULL OR "channel" = 'EMAIL'`.
- `UNIQUE ("addressHmac") WHERE "status" <> 'DELETED'`.
- CHECK `OpsAlertRecipient_shred_check`: `("status" = 'DELETED') = ("addressCiphertext" IS NULL)` ve şifreli alanların hepsi birlikte NULL/dolu; `addressHmac` NULL ⇔ `addressHmacVersion` NULL ⇔ DELETED.
- CHECK `OpsAlertRecipient_label_check`: `char_length(label) BETWEEN 1 AND 80`.
- Trigger `ops_alert_recipient_limit_fn`: INSERT ya da DELETED'dan çıkan UPDATE'te `pg_advisory_xact_lock(<OPS_ALERT_RECIPIENT_LOCK_KEY>)` alır ve DELETED olmayanların sayısı > 10 ise `RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = 'ops_alert_recipient_limit'`.
- `ALTER TYPE "AdminPermission" ADD VALUE IF NOT EXISTS ...` × 6 (aynı migration'da kullanılmaz).
- `OpsAlertDelivery.recipientId` FK → `OpsAlertRecipient(id)` `ON DELETE RESTRICT`.

- [ ] **Step 1: Failing test** `ops-alert-migration.spec.ts`:
  - `legacy delivery rows keep the per-channel uniqueness` — aynı (alert, OPENED, 0, EMAIL) iki satır `recipientId` NULL ile → ikincisi `skipDuplicates` ile 0 eklenir.
  - `two recipients may each have one row per notice` — iki farklı recipientId → 2 satır; aynı recipientId tekrar → 0.
  - `telegram row cannot carry a recipient` — CHECK ihlali (`23514`).
  - `a deleted recipient holds no ciphertext` — DELETED + dolu ciphertext → `23514`.
  - `the 11th live recipient is refused by the database` — 10 ACTIVE varken INSERT → hata, `constraint = 'ops_alert_recipient_limit'`; bir tanesi DELETED iken 11. INSERT başarılı.
  - `audit rows are append-only` — UPDATE ve DELETE → hata.
  - `routing settings start as ENV_LEGACY` — tek satır, `emailRouting = 'ENV_LEGACY'`.
- [ ] **Step 2:** `pnpm --filter @taktic/api exec vitest run test/ops-alert-migration.spec.ts` → FAIL (tablolar yok).
- [ ] **Step 3:** Şemayı yaz, SQL'i `prisma migrate diff` ile üret, ham SQL bloklarını ekle; migration başlığına OBS-ALERT-001 tarzı açıklama (ne ekler, neyi değiştirmez, rollback dosyası).
- [ ] **Step 4:** Test DB'ye migrate + test → PASS; `pnpm --filter @taktic/api exec vitest run test/ops-alerts.spec.ts` → PASS (OBS-ALERT-001 regresyonu yok).
- [ ] **Step 5: Commit** `feat(ops): OBS-ALERT-002 — recipient, routing and audit schema`.

### Task A2: Alıcı kriptografisi ve anahtar config'i

**Files:**
- Create: `apps/api/src/modules/ops-alerts/recipient-crypto.config.ts`, `apps/api/src/modules/ops-alerts/recipient-crypto.ts`
- Modify: `apps/api/src/boot-config.ts`, `apps/api/test/boot-config.spec.ts`, `scripts/ops/runtime-contract.mjs`, `scripts/ops/runtime-contract.test.mjs`, `scripts/ops/compose-security.mjs`, `docker-compose.yml`, `docker-compose.prod.yml`, `.env.example`
- Test: `apps/api/test/ops-alert-recipient-crypto.spec.ts`

**Interfaces:**
- Produces:
  - `type RecipientCryptoConfig = { encKeys: ReadonlyMap<string, Buffer>; activeKeyId: string; hmacKey: string; hmacVersion: number; source: 'environment' | 'development' }`
  - `resolveRecipientCryptoConfig(env?: NodeJS.ProcessEnv): RecipientCryptoConfig` (throws `OpsAlertRecipientCryptoConfigError`)
  - `assertOpsAlertRecipientCryptoConfig(): void`
  - `normalizeAddress(raw: string): string` (throws `InvalidRecipientAddressError`)
  - `type SealedAddress = { ciphertext: Buffer; nonce: Buffer; tag: Buffer; keyId: string }`
  - `encryptAddress(config, recipientId: string, address: string): SealedAddress`
  - `decryptAddress(config, recipientId: string, sealed: SealedAddress): string` (throws `RecipientDecryptError` — mesajında değer yok)
  - `addressHmac(config, normalized: string): { hmac: string; version: number }` (64 hex)
  - `DEVELOPMENT_RECIPIENT_ENC_KEYS`, `DEVELOPMENT_RECIPIENT_HMAC_KEY` (yayımlanmış, "not-secret" içeren değerler)

Nonce 12 bayt `randomBytes`; tag 16 bayt; AAD `Buffer.from('ops-alert-recipient:' + recipientId)`. Keyring biçimi `v1:<base64>,v2:<base64>`; her anahtar tam 32 bayt; aktif id keyring'de olmalı; yinelenen id reddedilir.

- [ ] **Step 1: Failing tests:**
  - `round-trips an address under the active key`
  - `refuses ciphertext moved to another recipient id` (AAD) → `RecipientDecryptError`
  - `refuses a tampered tag`
  - `decrypts with an older key still in the keyring`, `fails when the key id left the keyring`
  - `hmac is stable across case and whitespace`, `hmac changes with key and version`
  - `normalizeAddress rejects "Ad <a@x.com>", 255 chars, "a@x"`
  - `staging without keys refuses to boot; message names the variable, not the value` (değer gizli dizesi mesajda yok)
  - `development keys are refused on staging and production`
  - `keyring rejects a 31-byte key, a duplicate id, an active id not in the ring`
  - `boot-config.spec`: `assertOpsAlertRecipientCryptoConfig` boot sırasında çağrılır.
  - `runtime-contract.test.mjs`: staging/prod'da üç değişken eksik → FAIL; geliştirme anahtarı → FAIL; geçerli → PASS `"keyring v2 (2 keys), hmac v1"`; değer çıktıda yok.
- [ ] **Step 2:** İlgili vitest + `node --test scripts/ops/runtime-contract.test.mjs` → FAIL.
- [ ] **Step 3:** Uygula; `compose-security.mjs` gizli listesine `OPS_ALERT_RECIPIENT_ENC_KEYS`, `OPS_ALERT_RECIPIENT_HMAC_KEY`; compose dosyalarına `${VAR:-}` geçişleri; `.env.example`'a yorumlu şablon (değer yok).
- [ ] **Step 4:** Testler PASS; `pnpm --filter @taktic/api typecheck` PASS.
- [ ] **Step 5: Commit** `feat(ops): OBS-ALERT-002 — recipient address encryption and keyed identity`.

### Task A3: Alıcı servisi (CRUD, sınır, tekilleştirme, audit)

**Files:**
- Create: `ops-alert-recipients.service.ts`, `ops-alert-recipient.audit.ts`
- Modify: `apps/api/src/common/admin-audit.ts` (`AdminAuditDomain` += `'OPS_ALERT_RECIPIENT'`), `ops-alerts.module.ts`
- Test: `apps/api/test/ops-alert-recipients.spec.ts` (servis bölümü)

**Interfaces:**
- Consumes: A2 kripto fonksiyonları. (Son-kanal koruması A4'te bu servise bağlanır; A3'te `confirmLastCritical` alanı kabul edilir ama henüz değerlendirilmez.)
- Produces (`OpsAlertRecipientsService`):
  - `list(): Promise<RecipientView[]>`
  - `create(actor: AuthUser, input: { address: string; label: string; notifyWarning: boolean; notifyCritical: boolean; notifyRecovery: boolean }): Promise<RecipientView>`
  - `update(actor, id, input: { version: number; label?: string; notifyWarning?: boolean; notifyCritical?: boolean; notifyRecovery?: boolean; confirmLastCritical?: boolean }): Promise<RecipientView>`
  - `pause(actor, id, { version, confirmLastCritical? })`, `resume(actor, id, { version })`
  - `remove(actor, id, { version, reason: string; confirmLastCritical? })`
  - `replaceAddress(actor, id, { version, address, reason }): Promise<RecipientView>` (yeni alıcı aynı etiket/tercihlerle + eskisi DELETED, tek transaction; audit `ADDRESS_REPLACED` her iki id ile)
  - `reveal(actor, id): Promise<{ address: string }>` (audit `REVEALED`)
  - `auditPage(id | null, query: AuditPageQueryDto): Promise<AdminAuditPage>`
  - `type RecipientView = { id; label; maskedAddress; notifyWarning; notifyCritical; notifyRecovery; status; version; createdAt; updatedAt; lastSentAt: string | null; lastErrorCode: string | null; consecutiveFailures: number; keyId: string | null; isLastCritical: boolean }`
  - Hata sınıfları → HTTP: `RecipientLimitReachedError` 409 `RECIPIENT_LIMIT`, `DuplicateRecipientError` 409 `RECIPIENT_DUPLICATE`, `VersionConflictError` 409 `VERSION_CONFLICT`, `LastCriticalConfirmationRequired` 409 `LAST_CRITICAL_CONFIRM_REQUIRED`, `LastChannelProtectedError` 409 `LAST_CHANNEL_PROTECTED`, `RecipientDeletedError` 409 `RECIPIENT_DELETED`.

Tüm mutasyonlar `pg_advisory_xact_lock(OPS_ALERT_RECIPIENT_LOCK_KEY)` altında; `version` eşleşmesi `updateMany({ where: { id, version } })` ile; audit aynı transaction'da. `lastSentAt / lastErrorCode / consecutiveFailures` `OpsAlertDelivery`'den `recipientId` ile türetilir (≤ 10 alıcı, index `(recipientId, createdAt)` A1'e eklenir). `before/after` allowlist: `label`, `notifyWarning`, `notifyCritical`, `notifyRecovery`, `status`, `maskedAddress`.

- [ ] **Step 1: Failing tests:**
  - `create stores ciphertext and hmac, never the address` — ham SQL ile satır okunur, hiçbir sütunda adres dizesi yok; `maskedAddress = 'u***@icloud.com'`.
  - `create rejects a duplicate in another case` → `RECIPIENT_DUPLICATE`.
  - `rejects the 11th recipient when two creates race` — 9 alıcı + `Promise.all` iki create → biri başarılı, biri `RECIPIENT_LIMIT`.
  - `a deleted recipient frees a slot and its address may be added again`.
  - `update with a stale version is refused`.
  - `remove shreds ciphertext and hmac and records the reason`.
  - `replaceAddress keeps no pending delivery on the new id` — eski alıcının PENDING satırı CANCELLED/`RECIPIENT_REMOVED`, yeni alıcıda satır yok.
  - `audit rows carry masked address only` — JSON'da tam adres ve HMAC yok.
  - `reveal returns the address and writes REVEALED`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Uygula.
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(ops): OBS-ALERT-002 — managed recipient service with audit`.

### Task A4: Son kritik alıcı / son etkin kanal koruması

**Files:**
- Create: `apps/api/src/modules/ops-alerts/ops-alert-recipient-guard.ts`
- Modify: `ops-alert-recipients.service.ts` (`update/pause/remove/replaceAddress` kararı çağırır)
- Test: `apps/api/test/ops-alert-recipients.spec.ts` (guard bölümü)

**Interfaces:**
- Produces: `decideRecipientRemoval(input: { environment: AppEnvironment | null; telegramConfigured: boolean; routing: OpsAlertEmailRouting; liveCriticalAfter: number; touchesCritical: boolean; confirmed: boolean }): 'ALLOW' | 'CONFIRM_REQUIRED' | 'BLOCKED'`

Karar tablosu (`touchesCritical` = işlem bir ACTIVE∧critical alıcıyı bu kümeden çıkarıyor; `liveCriticalAfter` = işlemden sonra kalan ACTIVE∧critical sayısı):

| routing | liveCriticalAfter | environment | telegram | confirmed | sonuç |
|---|---|---|---|---|---|
| herhangi | ≥ 1 veya !touchesCritical | – | – | – | ALLOW |
| MANAGED | 0 | production | yok | – | BLOCKED |
| herhangi | 0 | diğer durumlar | – | false | CONFIRM_REQUIRED |
| herhangi | 0 | diğer durumlar | – | true | ALLOW |

(`ENV_LEGACY`'de yönetilen alıcılar yönlendirmeye katılmadığı için production engeli yalnız MANAGED'da; uyarı her modda.)

- [ ] **Step 1: Failing tests:** tablonun her satırı için bir `it.each`; ek olarak servis üzerinden `production guard reads telegram status per request` (env Telegram değişkenleri test içinde silinince aynı istek BLOCKED olur) ve `pausing the last critical recipient with telegram present needs confirmation`.
- [ ] **Step 2–4:** FAIL → uygula (servis `update/pause/remove/replaceAddress` içinde çağırır; `replaceAddress` yeni alıcı kritikse `touchesCritical=false`) → PASS.
- [ ] **Step 5: Commit** `feat(ops): OBS-ALERT-002 — last critical recipient and last channel guard`.

### Task A5: noticeSnapshot ve gizli alıcı log politikası

**Files:**
- Modify: `ops-alert.rules.ts`, `ops-alert-evaluator.service.ts` (`queue`), `ops-alert-delivery.worker.ts`, `notifications/notification.port.ts`, `resend-notification.adapter.ts`, `console-notification.adapter.ts`, `file-outbox-notification.adapter.ts`
- Test: `apps/api/test/ops-alerts.spec.ts` (yeni describe), `apps/api/test/ops-alert-privacy.spec.ts`

**Interfaces:**
- Produces:
  - `type NoticeSnapshot = { v: 1; severity: OpsAlertSeverity; emailData: Record<string, string>; telegramText: string }` (`severity` kuyruğa ekleme anındaki şiddet; A6 tercih kontrolü bunu okur)
  - `snapshotNotice(kind, alert: NoticeAlert, adminUrl: string | null): NoticeSnapshot` (`composeNotice` üzerine)
  - `readNoticeSnapshot(value: unknown): NoticeSnapshot | null` (allowlist doğrulaması; bozuksa null → canlı oluşturma)
  - `NotificationMessage.recipientLogPolicy?: 'masked' | 'hidden'` (varsayılan `'masked'`)
  - Gizli politika log metni: `RECIPIENT_HIDDEN_LABEL = 'alıcı gizli'`

Evaluator `queue` her yeni satıra snapshot yazar (alarm o anki hâliyle — OPENED için oluşturulan, REMINDER için güncellenmiş, RESOLVED için kapatılmış satır). Worker snapshot varsa onu, yoksa (migration öncesi satır) canlı `composeNotice` kullanır. Console adaptörü `hidden`'da `to` satırını production dışında da basmaz. File-outbox dosyaya `to` yazmaya devam eder (e2e artefaktı, log değil) ama log satırı gizli etiketi kullanır.

- [ ] **Step 1: Failing tests:**
  - `a retry sends the content frozen at queue time` — OPENED kuyruğa girer, alarm `occurrenceCount` artar, worker gönderir → e-posta datası ilk sayıyı taşır; ikinci denemede aynı data + aynı idempotency anahtarı.
  - `rows queued before the snapshot column compose live` — `noticeSnapshot` NULL satır → canlı içerik (OBS-ALERT-001 davranışı).
  - `ops-alert-privacy.spec`: logger spy; Resend (sahte HTTP sunucusu), console ve file-outbox adaptörleri `ops-alert` için hiçbir log satırında adresin yerel kısmını, `@` sonrası domain'i veya maskeli biçimi içermez; diğer template'ler `maskEmail` ile eskisi gibi.
  - Mevcut `ops-alerts.spec.ts` içinde send-time içerik varsayan bir assertion varsa, snapshot anına göre güncellenir ve commit mesajında belirtilir.
- [ ] **Step 2–4:** FAIL → uygula → PASS (`ops-alerts.spec.ts` tamamı dahil).
- [ ] **Step 5: Commit** `fix(ops): OBS-ALERT-002 — freeze notice content per delivery; hide alert recipients in logs`.

### Task A6: Evaluator fan-out ve worker çözümlemesi (MANAGED)

**Files:**
- Modify: `ops-alert.rules.ts`, `ops-alert-evaluator.service.ts`, `ops-alert-delivery.worker.ts`
- Test: `apps/api/test/ops-alert-managed-delivery.spec.ts`

**Interfaces:**
- Consumes: A2 `decryptAddress`; A5 `snapshotNotice`; A1 routing satırı.
- Produces:
  - `type NoticeTarget = { channel: 'TELEGRAM' } | { channel: 'EMAIL'; recipientId: string | null }` (`null` = env/legacy)
  - `noticeTargets(kind, severity, ctx: { routing: OpsAlertEmailRouting; config: OpsAlertConfig; recipients: ReadonlyArray<{ id: string; notifyWarning: boolean; notifyCritical: boolean; notifyRecovery: boolean }>; told: { telegram: boolean; legacyEmail: boolean; recipientIds: ReadonlySet<string> } }): NoticeTarget[]`
  - `ENV_LEGACY` dalı `noticeChannels` ile birebir aynı sonucu verir (eski fonksiyon bu dalı çağırır; dışa aktarımı korunur).

Evaluator: transaction'ın başında (advisory lock'tan sonra) `OpsAlertRoutingSettings` + ACTIVE alıcılar okunur; RESOLVED için `told` alıcı bazlı sorgulanır (`SENT|SENDING`, `recipientId` grupları). Worker `deliverOne`:
1. `recipientId` dolu → alıcıyı oku: DELETED → CANCELLED `RECIPIENT_REMOVED`; PAUSED → CANCELLED `RECIPIENT_PAUSED`; tercih kapalı (OPENED/REMINDER → `snapshot.severity`'ye göre `notifyWarning`/`notifyCritical`; RESOLVED → `notifyRecovery`) → CANCELLED `PREFERENCE_OFF`; çözme hatası → ABANDONED `DECRYPT_FAILED`; aksi halde çözülen adrese, `recipientLogPolicy: 'hidden'`.
2. `recipientId` NULL ∧ EMAIL ∧ mod `ENV_LEGACY` → OBS-ALERT-001 yolu (env adresi).
3. `recipientId` NULL ∧ EMAIL ∧ mod `MANAGED` → env adresinin HMAC'ı bir ACTIVE alıcıyla eşleşirse satır o alıcıya bağlanır (`recipientId` yazılır, aynı claim içinde) ve 1. yoldan gönderilir; eşleşmezse CANCELLED `LEGACY_AFTER_CUTOVER`.
CANCELLED kararları retry tüketmez ve `finish` claim token koşuluyla yazılır.

- [ ] **Step 1: Failing tests:**
  - `ENV_LEGACY ignores managed recipients entirely` — 3 ACTIVE alıcı, env adresi → yalnız 1 legacy e-posta satırı (+ kritikse Telegram).
  - `MANAGED fans out one row per matching recipient` — tercih × şiddet matrisi: WARNING → yalnız `notifyWarning`; CRITICAL → yalnız `notifyCritical`; Telegram değişmez.
  - `resolved goes only to told, active recipients with recovery on`.
  - `escalation reaches a critical-only recipient as a reminder`.
  - `each recipient retries and abandons on its own` — biri 5 kez TIMEOUT → ABANDONED, diğeri SENT.
  - `a removed recipient's pending row is cancelled and nothing is sent` — sahte port çağrı listesi boş.
  - `a retry after deletion cannot decrypt and is cancelled` — claim sonrası silme simülasyonu: ilk deneme TIMEOUT, alıcı silinir, ikinci claim → CANCELLED, port'a ikinci çağrı yok.
  - `a paused recipient's row is cancelled; resuming does not revive it`.
  - `a key removed from the keyring abandons with DECRYPT_FAILED and sends nowhere`.
  - `a legacy row in MANAGED binds to the recipient whose hmac matches the env address`, `…is cancelled when none matches`.
  - `two workers never deliver the same recipient row twice` (mevcut claim testinin alıcılı varyantı).
- [ ] **Step 2–4:** FAIL → uygula → PASS; `ops-alerts.spec.ts` PASS (ENV_LEGACY regresyonu).
- [ ] **Step 5: Commit** `feat(ops): OBS-ALERT-002 — per-recipient fan-out and recipient-bound delivery`.

### Task A7: Yönlendirme servisi (içe aktarma, geçiş, geri dönüş)

**Files:**
- Create: `ops-alert-routing.service.ts`
- Test: `apps/api/test/ops-alert-routing.spec.ts`

**Interfaces:**
- Produces (`OpsAlertRoutingService`):
  - `state(): Promise<RoutingState>` — `{ emailRouting; changedAt; envAddressConfigured: boolean; envAddressManaged: boolean; activeRecipients: number; liveCritical: number; telegramConfigured: boolean; keyIds: Record<string, number>; hmacVersions: Record<string, number> }`
  - `importFromEnv(actor): Promise<RecipientView>` — env adresini okur, A3 `create` ile üç tercih açık, etiket `"OPS_ALERT_EMAIL (içe aktarıldı)"`; audit `IMPORTED_FROM_ENV`; zaten yönetiliyorsa 409 `RECIPIENT_DUPLICATE`; env yoksa 409 `ENV_ADDRESS_MISSING`.
  - `type RoutingPreview = { direction: 'CUTOVER' | 'REVERT'; counts: Record<'PENDING' | 'FAILED' | 'SENDING', { rebind: number; cancel: number }>; told: number; blockers: RoutingBlocker[]; token: string }` — `token` = sayıların HMAC'ı (sunucu anahtarıyla; istemci üretemez).
  - `previewCutover(): Promise<RoutingPreview>`, `applyCutover(actor, { token }): Promise<RoutingState>`
  - `previewRevert(): Promise<RoutingPreview>`, `applyRevert(actor, { token, cancelUnmatched: boolean }): Promise<RoutingState>`
  - `RoutingBlocker = 'NO_LIVE_CRITICAL_CHANNEL' | 'LEGACY_ROWS_UNMATCHED' | 'ALREADY_IN_MODE'`

Kurallar:
- Geçiş: blocker yoksa tek transaction (evaluator ile aynı advisory lock): mod MANAGED; legacy PENDING/FAILED/SENDING e-posta satırları eşleşen alıcıya bağlanır (SENDING satırın claim'i korunur); legacy SENT satırlar için "told" eşleşen alıcıya geçer (satırın `recipientId`'si yazılır — tarihsel satıra tek değişiklik, audit `ROUTING_CUTOVER` sayılarla). Token yeniden hesaplanır; farklıysa 409 `COUNTS_CHANGED`.
- `LEGACY_ROWS_UNMATCHED`: env adresi hiçbir ACTIVE alıcıyla eşleşmiyor ve bekleyen legacy satır var → geçiş engellenir (kayıp/yönlendirme olmasın).
- Geri dönüş: mod ENV_LEGACY; bekleyen yönetilen satırlardan alıcı HMAC'ı env adresiyle eşleşenler `recipientId = NULL` yapılır (aynı adres, kayıp yok); eşleşmeyenler `cancelUnmatched=true` değilse 409 `CONFIRM_CANCEL_REQUIRED`, `true` ise CANCELLED `ROUTING_REVERTED`. Audit `ROUTING_REVERTED` sayılarla.

- [ ] **Step 1: Failing tests:**
  - `import stores the env address encrypted with all preferences on`, `import twice is a duplicate`.
  - `cutover binds pending legacy rows to the imported recipient and sends them there`.
  - `cutover carries told so a later RESOLVED reaches the imported recipient`.
  - `cutover is blocked with no live critical channel`, `…when legacy rows cannot be matched`.
  - `cutover refuses when legacy counts changed since preview` → `COUNTS_CHANGED`.
  - `a forged token is refused`.
  - `revert keeps matching rows and requires confirmation to cancel the rest`.
  - `evaluator and cutover serialise on the same lock` — evaluator tick ile `applyCutover` eşzamanlı; tüm yeni satırlar ya legacy ya yönetilen, karışık notice yok.
- [ ] **Step 2–4:** FAIL → uygula → PASS.
- [ ] **Step 5: Commit** `feat(ops): OBS-ALERT-002 — controlled ENV_LEGACY ⇄ MANAGED routing`.

### Task A8: Anahtar rotasyonu servisi

**Files:**
- Create: `ops-alert-key-rotation.service.ts`
- Test: `apps/api/test/ops-alert-recipient-crypto.spec.ts` (servis bölümü)

**Interfaces:**
- Produces: `rewrap(actor): Promise<{ rewrapped: number; failed: number }>` (aktif olmayan keyId'li ACTIVE/PAUSED alıcıları çöz + aktif anahtarla şifrele, alıcı başına audit `REWRAPPED`); `rehash(actor): Promise<{ rehashed: number; failed: number }>` (HMAC sürümü güncel olmayanlar; tekillik çakışması → o alıcı `failed`, işlem sürer). Her ikisi advisory lock altında, alıcı başına ayrı transaction.

- [ ] **Step 1: Failing tests:** `rewrap moves every live recipient to the active key and leaves deleted ones alone`, `rewrap reports a recipient whose key is missing as failed and changes nothing for it`, `rehash updates hmac and version; dedupe still holds afterwards`, `state().keyIds reflects the distribution`.
- [ ] **Step 2–4:** FAIL → uygula → PASS.
- [ ] **Step 5: Commit** `feat(ops): OBS-ALERT-002 — online key rewrap and rehash`.

### Task A9: Controller'lar, RBAC ve rapor projeksiyonu

**Files:**
- Create: `ops-alert-recipients.controller.ts`, `ops-alert-routing.controller.ts`, `dto/ops-alert-recipient.dto.ts`
- Modify: `auth/admin-permissions.ts` (`SUPER_ADMIN_RESERVED_PERMISSIONS` += `OPS_ALERT_ROUTING_MANAGE`), `auth/route-permission-map.ts`, `ops-alert.report.ts`, `system-health.service.ts`
- Test: `apps/api/test/ops-alert-recipients.spec.ts` (HTTP bölümü), `apps/api/test/admin-rbac-route-map.spec.ts`

**Interfaces — rotalar ve yetkiler:**

| Metot + yol | Yetki | Not |
|---|---|---|
| `GET /ops-alerts/recipients` | `OPS_ALERT_RECIPIENTS_READ` | maskeli liste |
| `POST /ops-alerts/recipients` | `OPS_ALERT_RECIPIENTS_WRITE` | |
| `PATCH /ops-alerts/recipients/:id` | `OPS_ALERT_RECIPIENTS_WRITE` | etiket/tercih, `version` |
| `POST /ops-alerts/recipients/:id/pause` · `/resume` | `OPS_ALERT_RECIPIENTS_WRITE` | |
| `POST /ops-alerts/recipients/:id/replace-address` | `OPS_ALERT_RECIPIENTS_WRITE` + `OPS_ALERT_RECIPIENTS_DELETE` | konjonktif |
| `DELETE /ops-alerts/recipients/:id` | `OPS_ALERT_RECIPIENTS_DELETE` | gövdede `version`, `reason` |
| `POST /ops-alerts/recipients/:id/reveal` | `OPS_ALERT_RECIPIENTS_REVEAL` | `Cache-Control: no-store` |
| `POST /ops-alerts/recipients/:id/test` | `OPS_ALERT_RECIPIENTS_TEST` | alıcı başına 1/dk, toplam 10/saat (429); senkron gönderim, idempotency `taktic-ops-alert-test-<auditId>`, audit `TEST_SENT` + kapalı sonuç kodu |
| `GET /ops-alerts/recipients/audit` · `/:id/audit` | `OPS_ALERT_RECIPIENTS_READ` | `AuditPageQueryDto` |
| `GET /ops-alerts/routing` | `OPS_ALERT_RECIPIENTS_READ` | `RoutingState` |
| `POST /ops-alerts/routing/import-env` · `/cutover/preview` · `/cutover` · `/revert/preview` · `/revert` · `/rewrap` · `/rehash` | `OPS_ALERT_ROUTING_MANAGE` (yalnız SUPER_ADMIN) | |

Rapor: `OpsAlertDeliveryView` += `recipientId: string | null`, `recipientLabel: string | null` (etiket, maskeli adres değil); `channels` += `emailRouting`, `managedRecipients: number`. Projeksiyon açık `select`.

- [ ] **Step 1: Failing tests:**
  - `route map covers every new route` (mevcut çift yönlü test yeni girdilerle).
  - RBAC matrisi `it.each`: her rota × {yetkisiz ADMIN → 403, doğru yetkili ADMIN → 2xx, SUPER_ADMIN → 2xx}; `OPS_ALERT_ROUTING_MANAGE` taşıyan rol oluşturma girişimi reddedilir; rol üzerinden verilmiş olsa bile ADMIN 403.
  - `list never returns ciphertext, nonce, tag or hmac` — yanıt anahtarlarının tam kümesi sabit.
  - `reveal sets no-store`, `test send is rate limited`.
  - `system health report lists recipient labels, never addresses`.
- [ ] **Step 2–4:** FAIL → uygula → PASS.
- [ ] **Step 5: Commit** `feat(ops): OBS-ALERT-002 — recipient and routing endpoints behind dedicated permissions`.

### Task A10: Runbook, rollback script'leri ve migration provası

**Files:**
- Create: `docs/ops/ops-alert-recipient-keys.md`, `scripts/ops/obs-alert-002-rollback-report.sql`, `scripts/ops/obs-alert-002-rollback-cancel.sql`, `scripts/ops/obs-alert-002-rollback.md`
- Modify: `docs/ops/ops-alerts.md`
- Test: `apps/api/test/ops-alert-migration.spec.ts` (script bölümü)

İçerik kararları:
- **Anahtar runbook'u:** üretim (`openssl rand -base64 32`), staging `.env`'e ekleme (`read -rs`, değer ekrana/geçmişe düşmez), **yedekleme** (DB dökümünden ayrı ortamda — örn. parola yöneticisi + çevrimdışı şifreli kopya; DB dump ile aynı dizine asla), **geri yükleme** (dump + anahtar sürümü eşleşmesi kontrolü: `state().keyIds`'teki her id keyring'de olmalı; eksikse alıcılar `DECRYPT_FAILED` → yeniden ekleme prosedürü), **rotasyon** (yeni anahtarı ekle → aktif yap → api recreate → `rewrap` → `keyIds` yalnız yeni id → eski anahtarı çıkar → recreate; HMAC için `rehash`), **kaybetme senaryosu** ve **sızma senaryosu** (rotasyon + rewrap + rehash + eski anahtarın imhası).
- **Rollback raporu (salt-okunur):** `recipientId IS NOT NULL` ve `status IN ('PENDING','FAILED','SENDING')` satırların durum bazında sayısı, ayrıca mod ve alıcı sayısı; değer basmaz.
- **Rollback iptali:** `psql -v expected='PENDING=<n>,FAILED=<n>,SENDING=<n>'` zorunlu; script güncel sayıları hesaplar, `expected` ile birebir değilse `RAISE EXCEPTION 'counts changed'` ve hiçbir şey yapmaz; eşitse tek transaction'da CANCELLED `ROLLED_BACK` (claim alanları NULL). Mod `MANAGED` ise önce `applyRevert` kullanılması gerektiğini söyleyip reddeder.
- **Rollback.md:** aşağıdaki "Migration / rollback prosedürü" bölümünün çalıştırılabilir hâli.

- [ ] **Step 1: Failing tests:** `rollback cancel refuses without expected counts`, `…refuses when counts differ`, `…cancels exactly the reported rows`, `…refuses while routing is MANAGED`, `report prints counts only` (çıktıda adres/HMAC yok).
- [ ] **Step 2–4:** FAIL → yaz → PASS (testler script'leri `psql` ile değil, aynı SQL'i test DB'de `$executeRawUnsafe` ile koşar).
- [ ] **Step 5: İzole prova** (yerel, ayrı DB; staging değil): yerel dökümden geri yüklenmiş kopyada 108→109 `migrate deploy`; OBS-ALERT-001 imajı (`d7c195a2`) aynı DB'ye karşı boot + bir alarm turu (Prisma'nın bilinmeyen uygulanmış migration'ı tolere ettiğini doğrula); rapor + iptal script'leri; sonuç teslim raporuna.
- [ ] **Step 6:** Tam paket: `pnpm --filter @taktic/api typecheck && pnpm --filter @taktic/api test && node --test scripts/ops/runtime-contract.test.mjs` → PASS.
- [ ] **Step 7: Commit** `docs(ops): OBS-ALERT-002 — recipient key runbook and count-confirmed rollback`.

---

## PR-B görevleri

### Task B1: Admin istemci katmanı ve etiketler

**Files:**
- Create: `apps/admin/lib/ops-alert-recipients.ts`
- Modify: `apps/admin/lib/api.ts`, `apps/admin/lib/permission-groups.ts` (yeni yetkilerin grubu "Operasyon alarmları"), `apps/admin/lib/confirmation-proof-keys.ts`
- Test: `apps/admin/test/ops-alert-recipients.spec.tsx`

**Interfaces:**
- Consumes: A9 rota ve yanıt şekilleri.
- Produces: `RecipientView`, `RoutingState`, `RoutingPreview` tipleri (API ile aynı adlar); `RECIPIENT_STATUS_LABELS`, `RECIPIENT_ERROR_TEXT` (A6'daki her kod + `RECIPIENT_LIMIT` … `COUNTS_CHANGED` için Türkçe metin), `recipientDeliverySummary(deliveries): string` ("E-posta: Yeni sorun — 2/3 gönderildi, 1 yeniden denenecek"); proof anahtarları `OPS_ALERT_RECIPIENT_PAUSE`, `_DELETE`, `_REPLACE`, `_REVEAL`, `_LAST_CRITICAL`, `OPS_ALERT_ROUTING_CUTOVER`, `OPS_ALERT_ROUTING_REVERT`, `OPS_ALERT_ROUTING_REWRAP`.

- [ ] **Step 1: Failing tests:** her hata kodunun boş olmayan metni var (`it.each` üzerinden API kod listesi); `recipientDeliverySummary` 0/1/çok alıcı ve legacy karışımı; yetki gruplarında altı yeni yetki tam bir kez.
- [ ] **Step 2–4:** `pnpm --filter @taktic/admin exec vitest run test/ops-alert-recipients.spec.tsx` FAIL → uygula → PASS.
- [ ] **Step 5: Commit** `feat(admin): OBS-ALERT-002 — recipient client, labels and confirmation keys`.

### Task B2: Bildirim Ayarları sayfası (liste + form)

**Files:**
- Create: `apps/admin/app/system-health/notification-settings/page.tsx`, `actions.ts`, `recipient-form.tsx`
- Modify: `apps/admin/app/system-health/page.tsx` (bölüm bağlantısı), `apps/admin/lib/system-health.ts` (kanal özeti alıcı bazlı)
- Test: `apps/admin/test/ops-alert-recipients.spec.tsx`, `apps/admin/test/system-health.spec.tsx`

UI kararları:
- Durum şeridi: yönlendirme modu ("Env (geçiş öncesi)" / "Yönetilen"), "x/10 alıcı", Telegram durumu, anahtar sürüm dağılımı (yalnız birden çok sürüm varsa).
- `ENV_LEGACY` modunda tablonun üstünde bilgi kutusu: "Bu alıcılar geçiş yapılana kadar bildirim almaz; şu an bildirimler OPS_ALERT_EMAIL adresine gidiyor."
- Tablo sütunları: Etiket · Adres (maskeli) · Uyarı · Kritik · Düzelme · Durum · Son gönderim · Son hata · ⋯
- Form: adres (yalnız eklemede), etiket, üç toggle; varsayılan Kritik + Düzelme açık, Uyarı kapalı. 10'a ulaşınca "Alıcı ekle" pasif + gerekçe metni.
- Yetkiye göre: READ yoksa bölüm hiç render edilmez (`mayEmbed` mantığı); WRITE yoksa toggle'lar salt-okunur.
- RouteDialog kullanılır; sayfa sorgu penceresinin üstüne `loading.tsx` eklenmez (feedback).

- [ ] **Step 1: Failing tests:** markup testleri — ENV_LEGACY bilgi kutusu; 10/10'da ekle pasif; READ-only kullanıcıda toggle `disabled`; maskeli adres görünür, tam adres markup'ta yok; sistem sağlığı alarm satırında alıcı bazlı özet.
- [ ] **Step 2–4:** FAIL → uygula → PASS.
- [ ] **Step 5: Commit** `feat(admin): OBS-ALERT-002 — notification settings list and recipient form`.

### Task B3: Satır eylemleri ve ConfirmGate'ler

**Files:**
- Create: `apps/admin/app/system-health/notification-settings/recipient-row-actions.tsx`
- Modify: `actions.ts`
- Test: `apps/admin/test/ops-alert-recipients.spec.tsx`

Kararlar:
- Pasifleştir, sil, adresi değiştir, göster → ConfirmGate (server action proof'u doğrular).
- Sil ve adresi değiştir gerekçe ister (≥ 5 karakter).
- API `LAST_CRITICAL_CONFIRM_REQUIRED` dönerse ikinci, ayrı uyarılı ConfirmGate: "Bu, kritik bildirim alan son e-posta alıcısı. Telegram yapılandırılmış olsa da e-posta ile kritik bildirim gelmeyecek." Onayla `confirmLastCritical=true` ile tekrar gönderilir.
- `LAST_CHANNEL_PROTECTED` → onay sunulmaz; "Production'da son etkin bildirim kanalı kaldırılamaz. Önce başka bir kritik alıcı ekleyin." metni.
- "Göster": adres yalnız o dialog içinde, sayfa durumuna/URL'ye yazılmadan gösterilir; kapatınca bellekten atılır.
- Test gönder: sonuç kodu toast'ta; 429 metni.
- `VERSION_CONFLICT` → `status-conflicts.ts` kalıbıyla yenile önerisi.

- [ ] **Step 1: Failing tests:** proof'suz server action çağrısı yazmaz (her eylem için); son kritik akışı iki adımlı; `LAST_CHANNEL_PROTECTED`'da onay düğmesi yok; reveal sonucu `searchParams`/cookie'ye yazılmaz.
- [ ] **Step 2–4:** FAIL → uygula → PASS.
- [ ] **Step 5: Commit** `feat(admin): OBS-ALERT-002 — recipient actions with confirmation gates`.

### Task B4: Yönlendirme paneli (içe aktar, geçiş, geri dönüş, rewrap)

**Files:**
- Create: `apps/admin/app/system-health/notification-settings/routing-panel.tsx`
- Modify: `actions.ts`, `page.tsx` (alta `AuditTimeline`)
- Test: `apps/admin/test/ops-alert-recipients.spec.tsx`

Kararlar:
- Panel yalnız SUPER_ADMIN'e render edilir.
- Adımlı görünüm: ① "OPS_ALERT_EMAIL'i içe aktar" (env yoksa gizli; zaten yönetiliyorsa "Env adresi yönetilen listede ✓") ② "Test gönder" hatırlatması ③ "Geçişi önizle" → durum bazında tablo (bağlanacak / iptal edilecek / bilgilendirilmiş aktarılacak) + blocker metinleri → ConfirmGate "Evet, yönetilen moda geç" (token ile).
- Geri dönüş aynı düzen; eşleşmeyen satır varsa ayrı onay kutusu "Eşleşmeyen N teslimatı iptal et".
- `COUNTS_CHANGED` → "Önizlemeden bu yana sayılar değişti; yeniden önizleyin."
- Rewrap/rehash yalnız birden çok sürüm varken görünür.

- [ ] **Step 1: Failing tests:** ADMIN'e panel render edilmez; blocker varken onay düğmesi yok; önizleme tablosu sayıları API'den aynen basar; `COUNTS_CHANGED` metni.
- [ ] **Step 2–4:** FAIL → uygula → PASS.
- [ ] **Step 5: Commit** `feat(admin): OBS-ALERT-002 — routing panel with preview-bound cutover and revert`.

### Task B5: E2E ve son doğrulama

**Files:**
- Create: `e2e/tests/admin-ops-alert-recipients.spec.ts`
- Modify: `e2e/tests/admin-system-health.spec.ts`, `e2e/tests/admin-system-screens.spec.ts`, `e2e/tests/admin-rbac-permissions.spec.ts`

- [ ] **Step 1:** Senaryo: SUPER_ADMIN → içe aktar → ikinci alıcı ekle → test gönder (file-outbox'ta mektup var, sayfada/loglarda tam adres yok) → önizle → geçiş → alıcıyı pasifleştir → son kritik uyarısı → sil (gerekçe) → audit zaman çizelgesinde olaylar → geri dönüş önizleme + onay. RBAC: yalnız READ'li rol düğmeleri görmez; yetkisiz rol bölümü görmez.
- [ ] **Step 2:** Sabit sekme/bölüm listelerini güncelle.
- [ ] **Step 3:** `pnpm --filter @taktic/admin typecheck && pnpm --filter @taktic/admin test` + ilgili Playwright projeleri (Chromium + WebKit; fullPage×DPR tuzağı için ekran görüntüsü yok) → PASS.
- [ ] **Step 4: Commit** `test(e2e): OBS-ALERT-002 — managed recipients flow`.

---

## Test matrisi (özet)

| Gereksinim | Test (task) |
|---|---|
| Şifreli saklama, DB'de düz adres yok | A3 `create stores ciphertext…`, A2 AAD/tag |
| HMAC tekilleştirme | A3 duplicate, A8 rehash |
| Sınır 10 + yarış | A1 trigger, A3 race |
| Değişmez recipientId, yönlendirme yok | A3 replaceAddress, A6 removed/paused/deleted/decrypt |
| Alıcı bazlı retry/idempotency/hata | A6 independent retry, A5 frozen content |
| Tercih × şiddet, düzelme yalnız bilgilendirilmiş | A6 matris, resolved |
| Son kritik uyarı + production son kanal engeli | A4 tablo, B3 iki adımlı akış |
| Maskeli yanıt, gizli log | A9 yanıt anahtar kümesi, A5 privacy spy, B2 markup |
| RBAC + SUPER_ADMIN reserved | A9 matris, B5 e2e |
| Audit append-only, allowlist | A1, A3 |
| ENV_LEGACY = OBS-ALERT-001 | `ops-alerts.spec.ts` tamamı her task'ta, A6 ENV_LEGACY |
| Geçiş/geri dönüş önizleme-onay, kayıp yok | A7 |
| Çoklu instance | A1 trigger, A6 two workers, A7 lock serialise |
| Rollback sayı-onaylı iptal | A10 |
| Anahtar rotasyonu | A2 keyring, A8 |
| Preflight/boot | A2 runtime-contract + boot-config |

---

## Migration / rollback prosedürü

### PR-A ileri yön (yerel → staging, her adım ayrı kullanıcı onayıyla)

1. Yerel: dump yedeği → `migrate deploy` 108→109 → yalnız api + admin recreate → `ops-alerts` smoke (mod ENV_LEGACY, ilk tick başarılı, 0 yönetilen satır).
2. Staging hazırlık (kullanıcı): iki sır üretilir, **önce yedeklenir** (runbook), sonra staging `.env`'e `read -rs` ile eklenir. Preflight `OPS_ALERT_RECIPIENT_*` PASS.
3. Staging deploy: dump yedeği + rollback tag → migrate → deploy → doğrulama: mod ENV_LEGACY, iCloud alıcısına giden mevcut akış değişmedi (kabul olayı ile bir OPENED/RESOLVED), Telegram değişmedi.

### PR-B ileri yön

4. Yalnız admin recreate. Geçiş operatör eylemidir (kullanıcı): içe aktar → test gönder (iCloud'a ulaştı mı kontrol) → önizle (bekleyen legacy satır sayıları) → geçiş.
5. Gözlem: bir sonraki alarm/hatırlatma `recipientId`'li satırla iCloud'a gitti. `OPS_ALERT_EMAIL`'in env'den kaldırılması ayrı, sonraki karar (Faz 4; boot kuralı değişikliği o işte).

### Rollback

- **R0 — yalnız geçişi geri al (en sık):** SUPER_ADMIN panelinde geri dönüş önizlemesi → sayılar operatöre gösterilir → onay. Kod değişmez.
- **R1 — PR-B geri al:** yalnız admin imajı önceki sürüme; veri etkisi yok. Mod MANAGED kalır; geri dönüş gerekiyorsa R0'ı API üzerinden (veya PR-A'nın endpoint'i ile) yap.
- **R2 — PR-A kod geri al (şema kalır):**
  1. Mod MANAGED ise önce R0.
  2. API'yi durdur.
  3. `obs-alert-002-rollback-report.sql` çalıştır, durum bazında sayıları operatöre göster.
  4. Operatör onaylarsa `obs-alert-002-rollback-cancel.sql -v expected='…'` (sayılar değiştiyse kendiliğinden reddeder). Onay yoksa durulur.
  5. `OPS_ALERT_EMAIL`'in env'de durduğunu doğrula.
  6. `d7c195a2` imajını başlat; ilk tick ve bir kabul olayı.

  Eski kod yeni tablo/sütunları yok sayar; legacy kuyruklama partial indeksle aynı kuralı korur (A10 provası bunu kanıtlar).
- **R3 — şema geri al:** Önerilmez. Alıcı bağlı teslimat satırları varken eski tam unique indeks kurulamaz; geçmiş silinmeden olmaz. Yalnız dump + açık karar; script yazılmaz, prosedür `rollback.md`'de "yapma, dump'tan dön" olarak geçer.

---

## Riskler

| Risk | Azaltma |
|---|---|
| Anahtar kaybı → adresler geri gelmez | DB'den ayrı yedek; restore'da keyId kontrolü; Telegram bağımsız; yeniden ekleme prosedürü |
| Prisma'nın bilinmeyen uygulanmış migration'ı R2'de tolere etmemesi | A10 izole prova; başarısızsa R2 adımına `_prisma_migrations` notu ve alternatif eklenir |
| e2e sabit sekme/bölüm listeleri | B5'te bilinçli güncelleme |
| Snapshot'ın 001 içerik assertion'larını değiştirmesi | A5'te açıkça listelenir; yalnız içerik anı değişir, yönlendirme değişmez |
| Test gönderiminin kötüye kullanımı (spam) | ayrı yetki + hız sınırı + audit |
| Geçiş anında rolling deploy (eski instance) | geçiş önizlemesi `ALREADY_IN_MODE` dışında, runbook ön koşulu "tüm api instance'ları 002"; staging tek instance |
