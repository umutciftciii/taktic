# OPS-DEPLOY-HARDENING-001 — Teslim raporu

- Taban: `main` `f2eb4e2223331b20222cab3c1de4b53a06d1c05c`, DB 86 migration
- Dal: `claude/deploy-runtime-security-58e04b`
- Migration: **yok** (şema değişmedi; DB 86'da kaldı)
- Staging/production'a deploy **yapılmadı**; Cloudflare/.env/Lemon/Resend ve
  PR #71'e dokunulmadı; host'ta LaunchDaemon/FileVault değişikliği yok.
- Runbook: [docs/ops/deploy-runtime.md](../../ops/deploy-runtime.md)

## 1. Değişen dosyalar

| Dosya | Ne |
|---|---|
| `Dockerfile` (yeni) | `api` / `web` / `admin` / `migrate` hedefleri, çok aşamalı, non-root |
| `.dockerignore` (yeni) | Allowlist |
| `docker-compose.prod.yml` (yeni) | Bağımsız staging/production stack'i |
| `docker-compose.yml` | Portlar `127.0.0.1`'e; staging yorumu güncellendi. Env ve davranış aynı. |
| `scripts/ops/*` (yeni) | build, preflight, deploy, smoke, backup (DB/uploads), restore provası, postgres geçişi, yerel eşitleme, imaj denetimi, migrate guard, compose güvenlik denetimi + testleri |
| `.github/workflows/ci.yml` | Yeni `ops` job'u |
| `.github/scripts/post-merge-gate.mjs` | Gate'in kanıt listesine `ops` job'u |
| `README.md`, `.env.example` | Deployment bölümü, deploy host anahtarları (yorum satırı) |

## 2. Dev ve production runtime farkı

Bkz. runbook §1. Özet: prod'da kod image içinde ve değişmez (bind mount yok,
host node_modules yok), API `node dist/main.js`, web/admin `next start`,
devDependency yok (`tsx`/`esbuild` budandı), `node` kullanıcısı (uid 1000), kod
salt-okunur, `init: true`, `no-new-privileges`, `cap_drop: ALL`. Geliştirme
stack'i aynen bind mount + hot reload.

## 3. Port matrisi

| Servis | Dev önce | Dev şimdi | Prod |
|---|---|---|---|
| postgres | 0.0.0.0:5433 | 127.0.0.1:5433 | yayınlanmaz |
| api | 0.0.0.0:3001 | 127.0.0.1:3001 | 127.0.0.1:3001 |
| web | 0.0.0.0:3000 | 127.0.0.1:3000 | 127.0.0.1:3000 |
| admin | 0.0.0.0:3002 | 127.0.0.1:3002 | 127.0.0.1:3002 |

Adresler literal; override'a bağımlı değil; `compose-security.mjs` CI'da
denetliyor.

## 4. Deploy script adımları ve migration-before-code

`scripts/ops/deploy-staging.sh --sha <commit>`: 0 build (git archive) → 1
preflight → 2 API stop → 3 checkout → 4 migrate status + birebir liste → 5
yedek (sha256 + `pg_restore --list` + migration sayısı) → 6 yalnız `migrate
deploy` → 7 status güncel + drift sıfır (değilse API başlatılmaz) → 8 API
recreate → 9 web/admin → 10 smoke + postgres container ID aynı. Hedef commit'in
script'leriyle çalışır (kendini `git archive` ile hazırlar). `migrate` image'ı
yalnız `status|deploy|drift|migrations` kabul eder; drift shadow DB'siz.
Ayrıntı: runbook §4.

## 5–7. Yedek / restore sonuçları (yerel ve izole prova)

- **DB yedeği** (yerel dev DB, salt-okunur `pg_dump`): 578 KB, 1012 TOC, 94
  TABLE DATA, 86 migration; sha256 `shasum -c` OK.
- **Uploads yedeği**: yerel API'nin bağladığı volume boş → varsayılan **exit 3,
  arşiv yazılmadı**; `--allow-empty` ile `empty=true` + uyarı. Host'taki ikinci
  `tactic_taktic-api-uploads` volume'u uyarıldı. Dolu test volume'u (3 dosya,
  boşluklu ad dahil) arşivlendi; symlink ve hard link içeren volume reddedildi.
- **Restore provası**: izole tek kullanımlık PostgreSQL'e restore → 86
  migration ve son migration manifest ile aynı, 94 tablo / tüm satır sayıları
  birebir, `migrate status` güncel, drift "No difference detected"; uploads'ta
  her dosyanın sha256'sı tuttu. Negatifler: bozuk gzip ("corrupt or
  truncated"), sidecar uyuşmazlığı, değişmiş içerik (per-file MISMATCH) hepsi
  FAIL. Prova sonrası container/ağ kalmadı.

## 8. OPS-003

Runbook §7. Repo + yerel kanıt boş export'un doğru olduğunu gösteriyor (yerel
DB'de 0 upload referansı, bağlı volume'da 0 dosya, Ağustos devrinde de 0), ama
bugünkü staging doğrulanmadı → **OPS-003 açık**. Staging'de çalıştırılacak
salt-okunur komutlar ve karar kuralı runbook'ta.

## 9. OPS-007

Runbook §8: seçenekler A–E, riskler, öneri (kısa vade A+B, orta vade C PoC,
uzun vade D; FileVault kapatılmamalı).

## 10. Testler

### Ara hedefli (izole "staging host" provası, scratchpad klonu, `taktic-rh-*`)

Eski durum simüle edildi: dev-compose şekli, her şey 0.0.0.0, root sahipli
uploads (1 dosya), override'a özgü env, gerçek **85 migration'lı** dump.

| Senaryo | Sonuç |
|---|---|
| Preflight (eski durum) | Beklenen 3 FAIL: postgres 0.0.0.0, uploads uid 0, override env; 1 bekleyen migration doğru |
| `--dry-run` | Hiçbir şey değişmedi (container'lar, postgres ID, 85 migration) |
| İlk geçiş (script'siz eski checkout, bootstrap ile) | Sıra birebir; **migrate deploy 85→86**; API healthy; web `next.config.ts` hatası yakalandı → düzeltildi |
| Sonraki deploy (hedef script'leriyle) | Migration atlandı, smoke 0 hata, postgres ID aynı |
| Drift enjeksiyonu | Önce adım 7'de durdu, API başlamadı; sonra preflight'a taşındı → hiçbir şey durmadan FAIL |
| `--backup` eski (85) / güncel (86) | Red / kabul |
| `postgres-cutover.sh` | Yayın kalktı, aynı volume, tüm satır sayıları yedekle aynı, smoke OK |
| `init: true` | `docker stop` 30 sn → ~0,25 sn |
| CI `ops` job simülasyonu (boş DB) | İmaj içeriği 0 hata, 86 migration, smoke 0, yedek+restore OK |
| `local-sync.sh --dry-run` (gerçek yerel stack) | Bekleyen yok; ana checkout ve `taktic-api` dokunulmadı |

Provada bulunup düzeltilen hatalar: `next start`'ın runtime'da TypeScript
kurmaya çalışması; macOS `/var`→`/private/var` symlink'i yüzünden denetim
CLI'ının **hiç denetlemeden exit 0** vermesi (realpath + açık "OK" satırı +
regresyon testi); checkout sırasında script sürüm karışması (hedef sürümle
yeniden çalıştırma); `pipefail` altında `grep -q` SIGPIPE riski; `pnpm deploy`'un
kök `tsx`/`esbuild`'i enjekte etmesi (budandı).

### FINAL aday (bir kez)

| Kontrol | Sonuç |
|---|---|
| API tam | 192 dosya / **4241 test geçti** (1139 s) |
| Admin unit | 35 dosya / **984 geçti** |
| Typecheck api/admin/web/shared/e2e | geçti |
| Build api/web/admin | geçti |
| Chromium tam E2E | **488 geçti, 1 başarısız**: `provider-claim.spec.ts:278` — yerel tek PostgreSQL'de bağlantı tükenmesi (Prisma "too many connections"); izole tekrarda 2'de 1 tekrarladı. Bu dalın `apps/ packages/ prisma/ e2e/` diff'i **boş**, uygulama artefaktları main ile aynı → PR kaynaklı değil; CI (her job'a ayrı PostgreSQL) hakem. |
| WebKit seçili set (`e2e:webkit`) | **307 geçti** |
| Production imaj build + içerik + compose denetimi + boot/smoke + yedek/restore | §11 |
