# Kategori operasyonel hazırlık durumu ve hizmet veren kaydı

Tarih: 2026-08-30

## Sorun

Bir taslak (`DRAFT`) kategorinin "yayına hazır mı" sorusunun bugün tek cevabı,
admin kategori listesindeki `releaseBlockers` verdict'i: kredi tanımlı mı,
onaylı hizmet veren var mı, uygunluk incelemesi gerekiyor mu. Bu verdict yayın
kararını yönetiyor ama **arz durumunu** ayrı bir olgu olarak adlandırmıyor.
"Onaylı hizmet veren bekleniyor" ile "hizmet veren hazır, kredi eksik" aynı
kırmızı rozete düşüyor.

İkinci ve daha büyük sorun: bir taslak kategoriye hizmet veren toplamanın tek
yolu, operatörün elle bağlaması ya da davet linki üretmesi. Kendi kendine kayıt
olan bir işletme — sözgelimi beyaz eşya tamircisi — henüz müşteri kataloğuna
açılmamış kendi uzmanlık alanını seçemiyor. Arz, yayından önce toplanamıyor.

## Çözümün iki yarısı

1. **Türetilmiş arz durumu** (`supplyStatus`): veritabanına yazılmayan, her
   okumada kategori + onaylı hizmet veren sayısı + fiyattan hesaplanan bir
   operasyonel gösterge. Yalnız operatörün gördüğü projeksiyonda.
2. **Hizmet veren kaydı kapısı** (`providerEnrollmentOpen`): adminin bir taslak
   hizmeti "başvuruya açık" hâle getirdiği tek bilinçli anahtar.

İkisi ayrı sorulara cevap veriyor ve ayrı kalıyorlar. Arz durumu bir ölçüm,
enrollment bir izin.

---

## 1. Veri modeli

`ServiceCategory` tek bir additive kolon alır:

```prisma
providerEnrollmentOpen Boolean @default(false)
```

Varsayılan `false`: yeni eklenen hiçbir kategori kendiliğinden hizmet veren
başvurusu toplamaya başlamaz. Açmak adminin bilinçli aksiyonudur.

`supplyStatus` **kolon değildir**. Kalıcı yazılsaydı, provider onaylandığında,
askıya alındığında, silindiğinde veya bağ kaldırıldığında güncellenmesi gereken
bir kopya olurdu; her biri kaçırılabilecek bir yazma noktası ve eşzamanlılık
riski. Türetilmiş olduğu için 1. ve 2. kural (onay sonrası otomatik yükselme,
onay kalkınca otomatik düşme) ayrıca kod gerektirmez — sonraki okuma yeni değeri
verir.

### Migration

`prisma/migrations/<ts>_add_provider_enrollment_open/migration.sql`:

```sql
ALTER TABLE "ServiceCategory"
  ADD COLUMN "providerEnrollmentOpen" BOOLEAN NOT NULL DEFAULT false;

UPDATE "ServiceCategory"
   SET "providerEnrollmentOpen" = true
 WHERE "status" = 'ACTIVE' AND "kind" = 'LEAF';
```

Backfill'in gerekçesi görünürden fazlası: yayındaki bir kategori sonradan
`DRAFT`'a çekilirse, saklanan kolon enrollment'ı belirleyen tek şey olur. `true`
ile başlamayan bir satır o geçişte başvuruyu sessizce kapatırdı. GROUP, ROUTER
ve INACTIVE satırlar `false` ile kalır.

### Import tanımları

`prisma/import-draft-categories.ts` ve `prisma/import-draft-categories-wave-2.ts`
içindeki 32 DRAFT LEAF hizmet, tanımda açıkça `providerEnrollmentOpen: true`
alır — hem create hem update yolunda, çünkü bu scriptler upsert.

Import gerçek dev veritabanında **çalıştırılmaz**; tanım değişir, uygulama
operatörün kararıdır.

---

## 2. Türetilmiş arz durumu

Yeni saf modül: `apps/api/src/modules/categories/category-supply-status.ts`.
Prisma'ya dokunmaz, `category-taxonomy.ts` ile aynı disiplinde — okuduğu iki üç
kolonu parametre olarak alır, böylece tüm matris veritabanı olmadan test edilir.

```ts
export type CategorySupplyStatus = 'EMPTY' | 'SUPPLY_READY' | 'LAUNCH_READY' | 'LIVE';

export function resolveCategorySupplyStatus(facts: {
  kind: ServiceCategoryKind;
  status: ServiceCategoryStatus;
  offerCreditCost: number | null;
  approvedProviderCount: number;
}): CategorySupplyStatus | null;
```

| Girdi | Sonuç |
|---|---|
| `kind !== LEAF` | `null` |
| `status === INACTIVE` | `null` |
| `status === ACTIVE` | `LIVE` |
| `DRAFT`, onaylı provider = 0 | `EMPTY` |
| `DRAFT`, onaylı provider ≥ 1, `offerCreditCost === null` | `SUPPLY_READY` |
| `DRAFT`, onaylı provider ≥ 1, `offerCreditCost > 0` | `LAUNCH_READY` |

ACTIVE bir kategori onaylı hizmet vereni olmasa da `LIVE` döner. "Yayında" bir
yayın olgusudur; arz eksikliğini mevcut `releaseBlockers` zaten ayrıca söyler ve
bu iki cümlenin karışması tam olarak kaçınılan şeydir.

`offerCreditCost` veritabanı CHECK kısıtı gereği ya `null` ya da `>= 1`; sıfır
ve negatif temsil edilemez, dolayısıyla üçüncü bir dal yoktur.

### Nerede hesaplanır

`CategoriesService` içinde, **yalnızca `includeInactive` (operatör)
projeksiyonunda**. Girdisi zaten orada bulunan `_count.providers` (APPROVED
filtreli), `offerCreditCost`, `kind`, `status`.

Hesap sunucuda yapılır ve `supplyStatus` alanı olarak döner; admin uygulaması
kendi aritmetiğini yapmaz. Kural 3'ün "server-authoritative" şartı budur.

Public liste, public detay, provider projeksiyonu, müşteri yanıtları: bu alan
**yok**. `includeInactive` güvenlik kuralı olduğu gibi korunur.

---

## 3. Hizmet veren kaydı kapısı

### Etkin kural

`category-taxonomy.ts` içine tek bir saf fonksiyon:

```ts
export function isProviderEnrollmentOpen(category: {
  kind: ServiceCategoryKind;
  status: ServiceCategoryStatus;
  providerEnrollmentOpen: boolean;
}): boolean {
  if (!isLeafCategory(category)) return false;
  if (category.status === ServiceCategoryStatus.ACTIVE) return true;
  return category.status === ServiceCategoryStatus.DRAFT && category.providerEnrollmentOpen;
}
```

`canBeSelectedByProviders` bu fonksiyona indirgenir. Bugünkü hâli "ACTIVE leaf"
idi; yeni hâli aynı kümeyi kapsar ve üzerine yalnız başvuruya açılmış taslak
LEAF'leri ekler. INACTIVE her koşulda kapalı, GROUP ve ROUTER her koşulda kapalı.

**ACTIVE LEAF her zaman açıktır** ve saklanan kolon onu kapatamaz. Bu bilinçli:
canlı bir kategoriyi hizmet veren kayıtlarına kapatmak, mevcut profillerin
kategori seçimini ve yeni kayıt akışını kıran, tek bir yanlış tıklamayla
ulaşılabilen bir durumdur.

`canBeAssignedByAdmin` **değişmez**. Admin bağlama ayrı bir koldur ve enrollment
bayrağına tabi değildir: operatör, başvuruya kapalı bir taslağa da elle işletme
bağlayabilir.

### Liste ile kapı aynı predicate'tir

Kayıt kataloğunun filtresi ile seçim kapısı aynı `isProviderEnrollmentOpen`
fonksiyonunu kullanır. İkisi ayrılırsa picker'ın göstermediği bir kategoriyi API
kabul eder ya da gösterdiğini reddeder; ikisi de kullanıcıya sebebi görünmeyen
bir hata olarak çıkar.

### Yazma kuralı

`providerEnrollmentOpen` yalnızca **sonuçtaki** kategori DRAFT LEAF olduğunda
yazılabilir. `CreateCategoryDto` ve `UpdateCategoryDto` alanı kabul eder;
`CategoriesService` payload'da alan varken sonuç DRAFT LEAF değilse 400 döner.
"Sonuçtaki" olması önemli: aynı PATCH `kind` veya `status` da değiştiriyor
olabilir, ve kural yazılan satıra uygulanır, önceki hâline değil.

Sessizce yok saymak yerine reddetmek: bir operatörün ya da bir istemcinin
"açtım" sanıp açmamış olması, bu özelliğin engellemek için var olduğu tam olarak
o durumdur.

---

## 4. Hizmet veren kayıt kataloğu

Yeni uç: `GET /categories/provider-enrollment`.

**Oturum gerektirmez.** Sorunun kendisi kendi kendine kayıt olan işletmenin
taslak kategoriyi seçebilmesiydi; `/providers/register` oturumsuz erişilebilir
bir sayfadır ve bu uç onu beslemek zorundadır.

Filtre: `isProviderEnrollmentOpen` — yani `LEAF` ve (`ACTIVE` veya
`DRAFT`+`providerEnrollmentOpen`).

Projeksiyon dar ve allow-list:

```ts
{
  id: string;              // form categoryIds gönderiyor; onsuz seçim yapılamaz
  name: string;
  slug: string;
  iconKey: string | null;  // CategoryVisual bu ikisini okur
  imageUrl: string | null;
  parent: { id: string; name: string; slug: string } | null;
  availability: 'LIVE' | 'UPCOMING';
}
```

`availability` `ACTIVE` için `LIVE`, `DRAFT` için `UPCOMING`. Kasıtlı olarak
`supplyStatus`'tan **ayrı bir sözlük**: hiçbir operasyonel bilgi taşımaz, yalnız
"bu hizmet şu an talep alıyor mu" der.

Dönmeyenler, tek tek ve bilerek: `status`, `offerCreditCost`, soru seti,
`_count` (provider, davet, soru, çocuk sayısı), `supplyStatus`, hazırlık ve
uygunluk bilgisi, `description`, `sortOrder`. Sıralama sunucuda yapılır ve
`sortOrder` yanıtta yer almaz.

### Kabul edilen açıklama

Bu uç, başvuruya açılmış taslak hizmetlerin **adını ve slug'ını** oturumsuz
erişilebilir kılar. Bu bilinçli bir takas: açıklanan şey "bu hizmeti yakında
açıyoruz ve şu an işletme arıyoruz" cümlesidir, ki işe alım tam olarak budur.
Kolon `false` ile başladığı için hiçbir kategori admin açıkça açmadıkça bu uçta
görünmez.

Açıklanmayanlar değişmez: müşteri kataloğu, kategori detayı, soru seti, talep
oluşturma, eşleşme, teklif ve e-posta fan-out taslak için kapalı kalır. Public
kategori API'si hiç değişmez.

### Nest rota sırası

`@Get('provider-enrollment')` mutlaka `@Get(':slug')`'dan **önce** tanımlanır;
aksi hâlde `:slug` onu yutar.

---

## 5. Hizmet verenin kendi paneli

Bugün `visibleServiceCategories` DRAFT bağları her non-admin projeksiyondan
tamamen düşürüyor — hizmet veren, seçtiği taslak kategoriyi kendi panelinde bile
göremiyor. Kendi kendine seçim mümkün hâle gelince bu bir güven sorunu olur:
kategori seçilmiş, sonra kaybolmuş görünür.

`providers.service.ts`:

- **owner ve admin** projeksiyonları ikinci bir liste alır:
  `upcomingServiceCategories: [{ id, category: { id, name, slug } }]` — yalnız
  DRAFT bağlar, dar shape.
- `serviceCategories` bugünkü gibi DRAFT'sız kalır. Eşleşme ve teklif tarafını
  okuyan hiçbir yer yanılmaz.
- **public** projeksiyon (`toPublicProvider`) bu listeyi **hiç almaz**.

Web panelinde ayrı bir bölüm: kategori adı ve tek bir ibare —
**"Yakında açılacak — henüz talep alamaz."**

Bu bölümde bulunmayacaklar: arz durumu, onaylı hizmet veren sayısı, başka
hizmet veren bilgisi, kredi, hazırlık metni. Bunlar operatör verisidir.

Görünürlük yalnız kendi bağları içindir. Başka hizmet verenler, müşteriler ve
public katalog taslak kategoriyi görmeye devam etmez.

---

## 6. Admin ekranı

### Etiketler

| `supplyStatus` | Etiket |
|---|---|
| `EMPTY` | Onaylı hizmet veren bekleniyor |
| `SUPPLY_READY` | Hizmet veren hazır · teklif kredisi tanımlanmalı |
| `LAUNCH_READY` | Yayına hazır |
| `LIVE` | Yayında |

Enrollment cümlesi aynı hücrede, `supplyStatus` ile birlikte:

- enrollment kapalı → "Yeni hizmet veren başvurusu kapalı"
- açık + `EMPTY` → "Başvuruya açık, onaylı hizmet veren bekleniyor"
- açık + `SUPPLY_READY` / `LAUNCH_READY` / `LIVE` → yukarıdaki durum etiketi

### Yerleşim

"Yayın hazırlığı" tablosuna **yeni bir sütun** eklenir. Mevcut "Yayına hazır
mı?" verdict'i ve `releaseBlockers` listesi (`NO_PRICE`,
`NO_APPROVED_PROVIDER`, `NEEDS_ELIGIBILITY_REVIEW`) olduğu gibi kalır.

İkisi farklı soruların cevabıdır ve yan yana durmaları gerekir: bir kategori
`SUPPLY_READY` olup kredi tanımsız olduğu için hâlâ "Hazır değil" kalabilir;
uygunluk incelemesi uyarısı dört duruma sığmaz ve kaybolmamalıdır.

Sıralama: `LAUNCH_READY` olanlar öne çıkar. Mevcut "az blocker önce"
sıralamasıyla uyumlu, tie-breaker olarak eklenir.

Kategori detayında aynı ikili, release checklist içinde bir satır olarak.

### Enrollment onay kutusu

Kategori formunda `providerEnrollmentOpen` için bir onay kutusu:

- **DRAFT LEAF** → düzenlenebilir
- **ACTIVE LEAF** → işaretli ve devre dışı, "Yayındaki hizmetlerde başvuru her
  zaman açıktır" açıklamasıyla
- **GROUP / ROUTER / INACTIVE** → işaretsiz ve devre dışı

Gösterilen değer etkin kuraldır (`isProviderEnrollmentOpen`), saklanan kolon
değil. Böylece ekran ile API'nin cevabı ayrışmaz.

### Aktivasyon

Kategori ACTIVE yapılırken otomatik yayın veya otomatik enrollment yazımı
**yoktur**. Aktivasyon aksiyonunun mevcut davranışı korunur.

---

## 7. Testler

### API

- `resolveCategorySupplyStatus` matrisi: her kind × status × kredi × provider
  sayısı kombinasyonu, veritabanısız tablo testi.
- `isProviderEnrollmentOpen` matrisi, aynı biçimde.
- APPROVED provider bağlanınca `EMPTY` → `SUPPLY_READY`; kredi tanımlıysa
  `LAUNCH_READY`.
- `PENDING_REVIEW` provider bağlanınca `EMPTY` kalır; provider sonradan
  `APPROVED` olunca yeniden bağlama olmadan durum değişir.
- Bağ silinince veya approval düşürülünce (`SUSPENDED`, `REJECTED`) durum geri
  düşer.
- DRAFT + `LAUNCH_READY` bir kategori için: public katalogda yok, public detay
  404, talep oluşturma reddedilir, eşleşme kimseye göstermez, teklif verilemez,
  e-posta fan-out açılmaz.
- Enrollment kapısı: başvuruya kapalı DRAFT LEAF seçimi 400; açık olan kabul;
  INACTIVE her hâlde 400; GROUP/ROUTER her hâlde 400; ACTIVE LEAF kolon `false`
  olsa da kabul.
- `providerEnrollmentOpen` yazma kuralı: DRAFT LEAF'e yazılır; ACTIVE LEAF,
  GROUP, ROUTER, INACTIVE için 400.
- `GET /categories/provider-enrollment`: oturumsuz 200; yalnız etkin kurala
  uyan satırlar; yanıt anahtarları tam olarak allow-list ile eşleşir
  (`supplyStatus`, `offerCreditCost`, `status`, `_count` yok).
- Sızıntı testleri: public kategori listesi/detayı, provider projeksiyonları
  (public, owner) ve müşteri yanıtlarında `supplyStatus`,
  `approvedProviderCount`, `_count.providers` ve hazırlık metni yok.
- `upcomingServiceCategories`: owner ve admin görür, public görmez;
  `serviceCategories` DRAFT içermez.

### E2E

- Admin ekranında dört durumun doğru görünmesi ve enrollment metinleri.
- Kendi kendine kayıt olan bir hizmet verenin başvuruya açık taslak kategoriyi
  seçebilmesi.
- Hizmet verenin kendi panelinde "Yakında açılacak — henüz talep alamaz"
  bölümünü görmesi ve o bölümde sayı/arz bilgisi bulunmaması.

### Korunacak mevcut testler

`provider-draft-category-binding`, `provider-invite-links`,
`category-release-readiness`, `category-wave-2-drafts`,
`category-taxonomy-rules` ve draft visibility testleri.

---

## Kapsam dışı

- Kategori aktivasyonunda otomatik yayın.
- Enrollment bayrağının davet linki üretimini etkilemesi.
- Gerçek dev veritabanında import, provider atama, kategori aktivasyonu, davet
  veya e-posta.
- Push, PR, merge, deploy, container recreate.
