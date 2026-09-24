# BUG-RBAC-STATUS-001 — Kategori ve kredi paketi PATCH'inde durum izni atlatması: teslim raporu

- **Tarih:** 2026-09-24
- **Taban:** `main@6c17a666`
- **Kaynak:** ADMIN-DESIGN-000 teslim raporu §5, N1
- **Kapsam:** yalnız API izin sözleşmesi ve bunun admin form uyumu.
  - Faz 1 (token, kabuk, font, logo, menü) başlamadı.
  - Yeni izin, migration, Prisma şeması, `.env` ve compose değişikliği yok.

## 1. Sorun

- `PATCH /categories/:id` ve `PATCH /credit-packages/:id` yalnız `*_WRITE` istiyordu.
- Gövdedeki `status`/`isActive` (kategoride ayrıca eski sözlükteki `isActive`) bu yoldan yazılabiliyordu.
- Sonuç: ayrı `*_STATUS` izni API seviyesinde atlatılabiliyordu. UI'ın mevcut değeri geri göndermesi bir güvenlik kontrolü değildi.

## 2. Kapsanan rotalar ve yazma yolları

Envanter: `serviceCategory` ve `offerCreditPackage` üzerindeki tüm `update`, `updateMany` ve `upsert` çağrıları tarandı. Uygulamada bu iki tabloyu güncelleyen yalnız dört servis yolu var.

| Rota | Önce | Sonra |
| --- | --- | --- |
| `PATCH /categories/:id` | `CATEGORIES_WRITE` | Kapıda `CATEGORIES_WRITE` **veya** `CATEGORIES_STATUS`. Serviste delta'ya göre kesin set (§3) |
| `PATCH /categories/:id/status` | `CATEGORIES_STATUS` | Değişmedi |
| `PATCH /credit-packages/:id` | `CREDIT_PACKAGES_WRITE` | Kapıda `CREDIT_PACKAGES_WRITE` **veya** `CREDIT_PACKAGES_STATUS`. Serviste delta'ya göre kesin set |
| `PATCH /credit-packages/:id/status` | `CREDIT_PACKAGES_STATUS` | Değişmedi |

Kapsam dışı bırakılanlar:
- **`POST /categories` ve `POST /credit-packages`:** ilk durumu oluşturma anında yazar; bu bir durum *değişikliği* değildir. `*_WRITE` ile kalır.
- **Admin'deki paket sıralama (↑/↓):** `PATCH /credit-packages/:id` ile yalnız `sortOrder` gönderir; iş alanıdır.

Uygulama:
- **Kapı:**
  - `@RequiresAnyPermission` (`auth/permissions.decorator.ts`), `PermissionsGuard`'da yeni bir "herhangi biri" dalı olarak eklendi.
  - Rota haritasına yeni `orInstead` alanı eklendi (`auth/route-permission-map.ts`).
  - Harita testi `@RequiresAnyPermission` metadata'sını okur, set eşitliğini denetler ve bu iki rotanın konjonktif değil "herhangi biri" rotası olduğunu ayrıca sabitler.
- **Kesin kontrol:** `assertDeltaPermissions` (`auth/delta-permissions.ts`). `CategoriesService.updateCategory` ve `CreditsService.updateCreditPackage` bunu tek bir `runSerializable` transaction'ı içinde, satırı okuduktan sonra çağırır.

## 3. İzin matrisi

Delta, transaction içinde okunan satır ile normalize edilmiş istek arasında hesaplanır. Aynı değerin geri gönderilmesi değişiklik sayılmaz.

| Oturum | Yalnız iş alanı delta'sı | Yalnız durum delta'sı | İkisi birden | Delta yok (no-op) |
| --- | --- | --- | --- | --- |
| Yalnız `*_WRITE` | 200 | **403**, hiçbir şey yazılmaz | **403**, hiçbir şey yazılmaz | 200 |
| Yalnız `*_STATUS` | **403**, hiçbir şey yazılmaz | 200 | **403**, hiçbir şey yazılmaz | 200 |
| `*_WRITE` + `*_STATUS` | 200 | 200 | 200 | 200 |
| İkisi de yok (ör. `*_READ`) | 403 (kapıda) | 403 (kapıda) | 403 (kapıda) | 403 (kapıda) |
| SUPER_ADMIN | 200 | 200 | 200 | 200 |

- **Kategoride iş alanları:** `name`, `slug`, `description`, `offerCreditCost`, `parentId`, `kind`, `imageUrl`, `coverImageUrl`, `iconKey`, `providerEnrollmentOpen`, `unlimitedPackageEligible`, `sortOrder`.
- **Kategoride durum:** `status` veya eski `isActive` (`resolveRequestedStatus`).
- **Kredi paketinde iş alanları:** pakete uygulanan tüm alanlar ve kapsam kümesi (sıra ve tekrar yok sayılır).
- **Kredi paketinde durum:** `isActive`.

## 4. No-op kararı

- **Hiçbir şey değiştirmeyen istek** (boş gövde ya da tüm değerler aynı): kapıdan geçen her oturum için bugünkü gibi `200` ve kayıt döner.
  - `*_WRITE` sahibi ve SUPER_ADMIN için davranış aynı.
  - Tek fark: yalnız `*_STATUS` sahibi daha önce bu rotada her istekte 403 alıyordu, şimdi değişiklik yoksa 200 alır. Hiçbir yetki kullanılmadığı için güvenlik etkisi yok.
- **Durum yalnız delta ise yazılır:** eskiden `status`/`isActive` gönderildiği her seferde yazılıyordu. Bu kararın sonucu olarak bayat bir form geri gönderimi kaydı geri çeviremez. Bayat değer satırla ya aynıdır (yazılmaz) ya da farklıdır (durum değişikliği, `*_STATUS` ister).
- **İş alanlarının yazımı** (Prisma `update`, `updatedAt` dahil) eskisi gibi, gönderilen her alan için yapılır.

## 5. Eşzamanlılık

- Okuma, delta hesabı, izin kontrolü ve yazma aynı Serializable transaction içinde yapılır. P2034'te yeniden denenir, bütçe tükenirse 409 döner.
- Test edilen iki senaryo:
  - **Bayat geri gönderim:** STATUS sahibi kapatır, ardından WRITE sahibinin eski formu `status: ACTIVE` ile gelir. Sonuç 403; ad ve durum değişmez.
  - **Gerçek yarış:** kategori ve paket için ayrı ayrı 6 tur. Kapatma isteği ile "ad + eski durum" isteği aynı anda gönderilir. Hangi sırayla koşarlarsa koşsunlar yazıcı durumu asla geri açamaz: kapatma başarılıysa son durum hep kapalıdır.

## 6. Yan bulgu: kategori durumu PATCH'le değişince vitrin

- **Eskiden:** `PATCH /categories/:id` ile verilen durum kategoriyi kapatıyor ama vitrin yerleşimlerini askıya almıyordu. Bunu yalnız `/status` rotası yapıyordu.
- **Şimdi:** iki rota da aynı `applyStatusChange` yardımcısını kullanır. Kapatma canlı yerleşimleri `CATEGORY_CLOSED` ile saati durdurarak askıya alır, yeniden açma onları sürdürür. Test edildi.

## 7. UI uyumu

- **İki izin birden:** form durum dahil çalışır.
- **Yalnız `*_WRITE`:**
  - Durum seçicisi görünür ama kilitlidir.
  - Kayıt artık durumu **hiç göndermez** (`statusLocked`); değer sunucuda olduğu gibi korunur. Kategori formu mevcut durumu gizli alanda taşımaya devam eder, çünkü kayıt ve uygunluk kuralları onu okur, ama API'ye göndermez.
  - Durum paneli ve paket aktif/pasif düğmesi görünmez.
- **Yalnız `*_STATUS`:** iş alanları salt okunur gösterilir, yalnız durum kontrolü (`/status` rotası) görünür.

**Yan düzeltme:** kredi paketi yeni ve düzenle ekranlarındaki fiyat alanının `pattern` özniteliği JSX'te `\\.` olarak çift kaçışlıydı. Bu yüzden binlik ayraçlı her fiyat (ör. "1.499,00") tarayıcı doğrulamasını geçemiyor, form hiç gönderilmiyordu. `\.` olarak düzeltildi; E2E alanın geçerliliğini de doğruluyor. Vitrin paketindeki eşdeğer desen bir JS dizesi olduğu için zaten doğruydu.

## 8. Testler

- **API** (`apps/api/test/admin-status-permission-delta.spec.ts`), kategori ve kredi paketi için ayrı ayrı:
  - İzin durumları: yalnız write, yalnız status, ikisi birden, hiçbiri, SUPER_ADMIN.
  - Delta durumları: no-op durum + write değişimi, tam no-op, eski sözlükteki `isActive`, kapsam kümesi değişikliği.
  - Eşzamanlılık: bayat geri gönderim ve gerçek yarış.
  - Kategori kapatmanın vitrin yan etkisi.
- **Harita:** `admin-rbac-route-map.spec.ts` herhangi-biri metadata'sını okuyor ve iki rotanın türünü sabitliyor.
- **E2E** (`e2e/tests/admin-status-permission.spec.ts`):
  - Write ve status oturumlarında kontrol görünürlüğü ve gönderim davranışı.
  - SUPER_ADMIN'in tek kayıtta alan ve durumu birlikte değiştirmesi.
  - Fiyat alanının geçerliliği.

## 9. Dokunulmayanlar

- **N2** (`/support/[id]` "Hesabı görüntüle" bağlantısı) ve **N3** (yerel admin container'ında `APP_ENVIRONMENT` yok) bu PR'da **dokunulmadan** açık kalır.
- Faz 1 başlamadı.
