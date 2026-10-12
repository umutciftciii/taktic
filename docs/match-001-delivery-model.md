# MATCH-001 — Kategori hizmet şekli ve konumdan bağımsız uzaktan eşleşme

Durum: uygulandı (PR `MATCH-001: add remote and hybrid category matching`).
Baz: `v0.2.0` / main `2869fc62`. Migration: 99 → 100
(`20261014090000_add_category_delivery_model`).

## 1. Kanonik model

| Kategori `deliveryModel` | Talep `deliveryMode` | Konum eşleşmesi |
| --- | --- | --- |
| `ON_SITE` (varsayılan) | her zaman `ON_SITE` | sağlayıcı hizmet bölgeleri — v0.2.0 ile birebir aynı |
| `REMOTE` | her zaman `REMOTE` | **yok**: kategoriye bağlı her APPROVED sağlayıcı, bölgesi ne olursa olsun |
| `HYBRID` | müşterinin seçimi (`ON_SITE` \| `REMOTE`), **zorunlu** | seçilen moda göre |

- `ServiceCategory.deliveryModel` (`CategoryDeliveryModel`): kategorinin neye izin
  verdiği. Yalnız **yeni talep oluşturulurken** okunur.
- `ServiceRequest.deliveryMode` (`RequestDeliveryMode`): talebin oluşturulduğu
  andaki snapshot'ı; talep ömrü boyunca (her tur dahil) konum eşleşmesinin tek
  otoritesi. Değişmez.
- Tek talepte iki mod yok (v1).

## 2. Talep snapshot'ı ve değişmezlik

- Çözüm tek yerde: `apps/api/src/common/delivery-mode.ts › resolveRequestDeliveryMode`.
  - ON_SITE/REMOTE kategori modu sabitler; gövdede çelişen bir mod → `400 DELIVERY_MODE_MISMATCH`.
  - HYBRID'de mod yoksa → `400 DELIVERY_MODE_REQUIRED`.
  - Yönlendirmeli (router) akışta mod, talebin gerçekten düştüğü **yaprak** kategoriden çözülür.
- Veritabanı invariant'ı: `ServiceRequest_delivery_mode_guard` trigger'ı
  - INSERT'te modun kategoriyle uyuşmadığı satırı reddeder (yazan kim olursa olsun);
  - `deliveryMode`'u değiştiren her UPDATE'i reddeder (`check_violation`).
- Kategori `deliveryModel`'i değişince (ON_SITE ↔ REMOTE ↔ HYBRID) mevcut
  talepler **değişmez**; yeni talepler yeni modeli kullanır. Kategori düzenlemesi
  talep tablosuna hiç yazmaz (testle sabit: `match-001-delivery-model.spec.ts ›
  existing request snapshot`).
- Talebin kategorisi oluşturulduktan sonra hiçbir yolda değişmez (incelendi), bu
  yüzden INSERT-anı kontrolü yeterlidir.

## 3. Konum verisi (REMOTE)

- `city` / `district` REMOTE talepte de **zorunlu kalır** ve saklanır: müşterinin
  bulunduğu yer olarak bağlam, raporlama, admin araması, e-postalar ve ~35 ekran
  bu iki NOT NULL kolonu okur. Eşleşme kararı bunları REMOTE'ta **okumaz**.
- Formda alan başlığı "Konumunuz" olur ve "il ve ilçe yalnız bağlam olarak
  paylaşılır; hangi hizmet verenlerin göreceğini sınırlamaz" notu gösterilir.
- Zorunlu `ADDRESS` sistem sorusu (mahalle şartı) REMOTE talepte uygulanmaz.
- Bilinçli sınır (borç): REMOTE talepte il/ilçeyi tamamen opsiyonel yapmak
  kolonları nullable yapmayı ve tüm okuyucuları güncellemeyi gerektirir; v1'de
  yapılmadı.

## 4. Kanonik eşleşme (karar sırası)

Tüm sağlayıcı yüzeyleri aynı soruyu sorar; konum adımı tek fonksiyondur:
`provider-request-matching.ts › matchesRequestLocation(areas, request)`.
`request` tipi `deliveryMode` içerir — seçmeyi unutan çağıran derlenmez.

1. sağlayıcı APPROVED (`getApprovedProviderForDiscovery`)
2. kategori bağı (DRAFT bağlar hariç)
3. telefon doğrulama ve vitrin (direct) kapıları
4. talep APPROVED (veya sağlayıcının kendi SUBMITTED direct lead'i), mevcut tur OPEN, bu turda teklifi yok
5. REL-002 dışlama (`ServiceRequestProviderExclusion`)
6. **konum**: `ON_SITE` → `matchesProviderArea`; `REMOTE` → atlanır
7. teklif yolunda ayrıca: kategori aktif, fiyat tanımlı, beklenen kredi, takvim, kredi/hak, duplicate (`Offer_round_open_guard` trigger'ı dahil)

REMOTE yalnız 6. adımı atlar; başka hiçbir guard gevşemez.

### Kopya konum kuralı envanteri (önce / sonra)

v0.2.0'da `matchesProviderArea` dört noktada doğrudan çağrılıyordu:

| Yüzey | Dosya | Şimdi |
| --- | --- | --- |
| Discovery listesi | `providers.service.ts › listMatchingRequests` | `matchesRequestLocation` |
| Talep detayı | `providers.service.ts › getMatchingRequest` | `matchesRequestLocation` |
| Teklif hızlı kontrol + Serializable otorite | `canProviderActOnRequest` | `matchesRequestLocation` |
| Yayın fan-out + gönderim anı yeniden kontrol | `transactional-mail.service.ts › findMatchingProviders` | `matchesRequestLocation` |

Konum, SQL'de hiçbir yerde filtrelenmez (eşleşme bellek içi). DB trigger'ları
konum kontrol etmez. Vitrin rafı (`assertPlacementServesRequest`) ayrı bir
kuraldır, §7.

## 5. Discovery ve teklif

- Discovery SQL'i değişmedi (kategori + durum + tur + dışlama); REMOTE talepler
  bellek içi alan filtresinden muaf. Sayfalama/filtre semantiği aynı.
- Yanlış bölgeden stale URL/API ile teklif: ON_SITE → mevcut `404 Request not found`;
  REMOTE → bölge kontrolü yok. Yeni hata kodu eklenmedi.
- Projeksiyon: sağlayıcı liste/detay yanıtına yalnız `deliveryMode` eklendi;
  müşteri iletişim bilgisi, adres notu, PII, tarihsel tur izolasyonu ve
  iletişim paylaşımı kuralları değişmedi (REMOTE adres açmaz).

## 6. Bildirim fan-out

- `request-available` hedef kitlesi `findMatchingProviders` ile; REMOTE'ta
  kategoriye bağlı tüm uygun sağlayıcılar (bölgesiz olanlar dahil).
- Dedupe: `request-available:<req>:<provider>[:r<N>]` — sağlayıcı başına tek
  kayıt, tur bazında (REL-002) korunur. Dışlanan sağlayıcıya fan-out yok.
- E-posta: REMOTE'ta konu "Uzaktan yeni talep", gövdede "Hizmet şekli: Uzaktan
  hizmet" satırı ve "hizmet bölgeniz eşleşmeyi sınırlamaz" cümlesi. ON_SITE e-postası
  birebir aynı.

## 7. Vitrin / direct lead

- Lead'in modu kartın kategorisinden (HYBRID'de müşterinin seçimi) aynı
  `resolveRequestDeliveryMode` ile çözülür ve talebe snapshot'lanır.
- ON_SITE (ve HYBRID+ON_SITE): raf bölgesi kontrolü (`SHOWCASE_LEAD_AREA_NOT_SERVED`) aynen.
- REMOTE: müşterinin adresi raf dışında olsa da lead kabul edilir; kart sahibi
  kendi profil bölgesinden bağımsız teklif verir.
- Lead marketplace'e bırakıldığında (RELEASE) veya REL-002 R2+ açıldığında
  talebin `deliveryMode`'u aynı kalır (kolon değişmez; trigger garantisi).

## 8. REL-002 uyumu

REMOTE talep: R1 fail → R2 → R3 fail → `MATCH_REVIEW` → admin R4. Her turda
`deliveryMode=REMOTE`; başarısız sağlayıcılar ülke çapında dışlı kalır; manuel
R4 yayını bölge filtresi uygulamaz (test: `REL-002 rounds on a REMOTE request`).

## 9. Sağlayıcı bölge zorunluluğu

- Başvuru/profil kaydı: seçilen **tüm** kategoriler REMOTE ise hizmet bölgesi
  istenmez (`providerNeedsServiceArea`). Herhangi bir ON_SITE/HYBRID kategori
  varsa "En az bir hizmet bölgesi" kuralı aynen.
- Bölgesiz bir sağlayıcı sonradan ON_SITE kategori eklerse kayıt bölge ister;
  bir kategori REMOTE→ON_SITE yapılırsa bölgesiz sağlayıcılar yeni ON_SITE
  taleplerle eşleşmez (alan yoksa eşleşme yok — mevcut kural).
- UI: bölge seçicisinin yanında "Uzaktan sunulan hizmetler … bölge seçimi
  eşleşmeyi sınırlamaz" / "Hibrit hizmetler … yalnız yerinde istenen taleplerde"
  notu (`ServiceAreaDeliveryNote`). `GET /categories/provider-enrollment`
  projeksiyonuna `deliveryModel` eklendi (zaten herkese açık bilgi).

## 10. UX

- Admin kategori oluştur/düzenle: "Hizmet şekli" select'i (Yerinde / Uzaktan /
  Hibrit) + üç yardım cümlesi (`aria-describedby`). Hizmet (LEAF) kategoride
  model değişikliği onay ister (`category.delivery-model-update`); audit
  geçmişinde "Hizmet şekli" alanı.
- Admin talep detayı: "Hizmet şekli (talep)" ve "Kategori hizmet şekli (bugün)";
  farklıysa nötr not "Kategori sonradan değişti; bu talep oluşturulduğu hizmet
  şeklini korur." (hata/uyarı stili yok). Liste satırında "· Uzaktan".
- Müşteri formu: HYBRID'de zorunlu, ön seçimsiz iki radio ("Yerinde hizmet" /
  "Uzaktan hizmet"); REMOTE'ta bilgi notu. Vitrin lead formunda aynı bileşen.
  Seçim taslakla (giriş/aktivasyon dönüşü) korunur.
- Sağlayıcı ekranları: REMOTE talepte konumun yanında metin rozeti "Uzaktan".
- Müşteri talep içeriği: REMOTE'ta "Hizmet şekli: Uzaktan hizmet" satırı.
- Bilgi asla yalnız renkle verilmez; yeni kontrollerin hepsi etiketli.

## 11. Migration ve geri dönüş

- Additive: iki enum, iki `NOT NULL DEFAULT 'ON_SITE'` kolon, bir trigger.
  PostgreSQL sabit default'u katalogda tutar; tablo yeniden yazılmaz, UPDATE
  yok, sahte REMOTE durumu yok. Trigger kolonlardan sonra kurulur.
- Geri dönüş: `scripts/ops/match-001-rollback.sql` — yalnız tüm kategoriler ve
  tüm talepler ON_SITE iken çalışır (aksi hâlde kendini reddeder); şemayı
  v0.2.0'a (99 migration) döndürür, veri değişmez.
- **Geri dönüş sınırı:** ilk REMOTE/HYBRID kategori veya ilk REMOTE talep
  oluştuktan sonra geriye şema dönüşü yoktur — kolonu düşürmek REMOTE talebi
  sessizce ON_SITE yapar ve teklif vermiş sağlayıcılardan gizler. Bu noktadan
  sonra yalnız ileri düzeltme.

### Prova (2026-10-12, yerel)

- Yedek: `~/Backups/taktic/db/taktic-db-20261012T185924Z-pre-match001-2869fc62.dump`,
  sha256 `bf75403ff293e62ff515a13241581a70c4db45fedd497d66dd3cd89add69227a`.
- İzole restore (`taktic_match001_rehearsal`, aktif DB'den ayrı, sonra silindi):
  99 migration; parmak izi (kategori/talep/bölge sayıları + md5) aktif DB ile aynı.
- 99 → 100: 1.18 sn; ikinci deploy "No pending"; drift 0; parmak izi aynı;
  tüm talepler ve kategoriler ON_SITE; trigger mevcut.
- Rollback provası: 100 → 99, drift (v0.2.0 şemasına karşı) 0, parmak izi aynı.
- Ölçek provası (sentetik: 400 kategori, 20k sağlayıcı, 60k kategori bağı,
  80k bölge, 200k talep): 99 → 100 1.0 sn; `ServiceRequest` relfilenode aynı
  (yeniden yazım yok, 153 MB); 200.023 satır ON_SITE.

## 12. Performans

Aynı sentetik veri setinde `EXPLAIN ANALYZE`:

| Sorgu | Plan | Süre |
| --- | --- | --- |
| Discovery (3 kategorili sağlayıcı, 500 aday) | `categoryId` + `status` BitmapAnd, tur PK, `Offer(providerId, matchRoundId)` anti-join | 82 ms |
| Fan-out adayları (REMOTE kategori, 150 sağlayıcı) | `ProviderServiceCategory_categoryId_idx`, alanlar `providerId` index'i | 30 ms |
| Teklif uygunluk okuması | PK | 0.1 ms |
| Kategori modeli filtresi | küçük tablo seq scan | 0.07 ms |

- REMOTE için SQL değişmez: konum zaten bellek içi filtreydi; REMOTE yalnız
  filtreyi atlar. "Tüm sağlayıcılar" taraması yok — aday kümesi kategori
  bağıyla sınırlı. Yeni index eklenmedi.
- Mevcut borç (bu PR'dan bağımsız): fan-out'ta `ProviderProfile` 20k satırda
  seq scan + hash semi join seçiliyor (status seçici değil); discovery adayları
  belleğe yükleyip filtreliyor.

## 13. Testler

- API: `apps/api/test/match-001-delivery-model.spec.ts` (matris: kategori,
  oluşturma, DB invariant, discovery/detay/teklif/fan-out, değişmezlik, sağlayıcı
  bölgesi, vitrin, REL-002 zinciri, kategori kapıları).
- Shared: `packages/shared/src/delivery-model.spec.ts`.
- Web: `apps/web/test/delivery-mode.spec.tsx`.
- Admin: `apps/admin/test/match-001-delivery-model.spec.tsx`, `confirmation-proof.spec.ts`.
- E2E: `e2e/tests/remote-hybrid-matching.spec.ts`.

## 14. Açık borçlar

- REMOTE talepte il/ilçeyi tamamen opsiyonel yapmak (nullable kolon + okuyucular).
- Sağlayıcı teklif/mesaj ekranlarında (teklif listesi, mesajlar, vitrin lead listesi) "Uzaktan" rozeti yok.
- Davet (provider-invite) formunda bölge notu gösterilmiyor (API kuralı yine geçerli).
- Bölgesiz (yalnız REMOTE) sağlayıcı vitrin kartı açamaz (kart alanları profil kapsamı ister).
- Admin talep listesinde/aramasında hizmet şekline göre filtre yok.
