# SEO-002 — Organik keşif ve içerik/landing stratejisi — Teslim Raporu

Tarih: 2026-09-18 · Branch `claude/seo-002-organic-content-strategy-df74e4` (taban `origin/main` @
`e51c950c`, temiz worktree doğrulandı) · PR [#92](https://github.com/umutciftciii/taktic/pull/92) · **Docs-only PR** · head/CI §8'de.

Değişen: yalnız iki dosya — `docs/superpowers/specs/2026-09-18-seo-002-organic-discovery-content-strategy.md`
(strateji) ve bu rapor. Üretim route'u, metadata, sitemap/robots, veritabanı, migration, gerçek `.env`,
Cloudflare, Search Console, deploy, yerel/staging container: **dokunulmadı**.

Kanıt sınırı: sayılar yerel Docker DB'den (2026-09-10 staging kopyası + yerel test verisi) salt-okunur
sorguyla alındı; **production verisi bilinmiyor**. Anahtar kelime hacmi verilmedi (Keyword Planner /
Search Console erişimi yok); yerine ölçüm planı var.

---

## 1. Mevcut envanter özeti

| Yüzey | URL | İçerik | Sitemap | İnce-içerik riski | Yerel sayı |
| --- | --- | --- | --- | --- | --- |
| Ana sayfa | `/` | özgün landing + SSS (6) + 10 kategori kartı + vitrin rafı | evet | düşük | 1 |
| Kategori dizini | `/categories` | liste + arama (`?q=` noindex) | evet | orta | 1 |
| Kategori sayfası | `/categories/<slug>` | ad + **tek cümle açıklama (23–43 karakter)** + talep formu; hizmet veren listesi/rehber/SSS yok; görsel 0/7 | evet | **yüksek** | 7 ACTIVE leaf |
| İşletme profili | `/isletme/<id>` | ad + il/ilçe + kategori etiketi (link değil) + bölge etiketi; `description` **0/3** dolu; puan eşik altı | evet | **yüksek** | 3 APPROVED (1 gerçek, 2 kabul-testi görünümlü) |
| Vitrin rafı | `/vitrin` | kart ızgarası + il/ilçe filtresi (`?il/ilce` noindex) | evet | orta–yüksek | 2 canlı kart |
| Vitrin kartı | `/vitrin/<cardId>` | başlık, özet (91–116 karakter), fiyat, kapsam (1–2 madde), SLA; kategori link değil | evet (lastmod yok) | orta | 2 |
| Sözleşme | `/sozlesmeler/iletisim-paylasimi` | hukuki | hayır (`noindex, follow`) | — | 1 |
| Yardım/KVKK/Gizlilik/Şartlar | **yok** (footer linkleri `href="#"`) | — | — | — | 0 |
| Rehber/makale | **yok** | — | — | — | 0 |
| Kategori × il/ilçe | **route yok**; tek konum filtresi `/vitrin?il=&ilce=` = aynı sayfanın filtre varyantı (noindex, canonical yok), landing değil | — | — | — |

Ek tespitler: aktif kategori ad/açıklamalarında Türkçe karakter yok ("Klima Montaji", "Elektrikci",
"Ev Temizligi"); DRAFT taksonomi 10 grup + 32 leaf (Türkçe karakterli), "Dijital ve Yaratıcı" ve
"Kurumsal ve Danışmanlık" grupları dahil. Veri modeli uzaktan/konumdan bağımsız hizmeti ifade
**etmiyor** (`ProviderServiceArea.scope ∈ {CITY, DISTRICT, NEIGHBORHOOD}`, talepte `city/district`
zorunlu, `matchesProviderArea` yalnız coğrafi) — eşleşme kuralı değiştirilmedi, yalnız not.

Marka yazımı: `TakTick` 81 / `TakTic` 31 kullanım (`.ts/.tsx`). Aynı sayfada `<title>` "TakTic …",
`og:site_name` ve JSON-LD "TakTick"; footer © "TakTic"; `TAKTIC_APP_NAME = 'TakTic'` (e-posta
şablonları). Alan adı referansı `taktick.com.tr`. Metin değiştirilmedi; karar B7 backlog'unda.

## 2. İndeksleme karar tablosu

| Sınıf | Karar | Giriş kriteri (özet) | Yerel durum |
| --- | --- | --- | --- |
| `/` | şimdi indeksle | — | ✔ |
| `/categories` | şimdi indeksle | ≥1 aktif kategori | ✔ |
| `/categories/<slug>` | koşulla indeksle | açıklama ≥2 paragraf (başlangıç önerisi ≥400 karakter), ≥3 içerik bloğu, görsel, Türkçe karakterli ad | 0/7 |
| `/isletme/<id>` | koşulla indeksle | minimum indexable profile (§4) | 0/3 |
| `/vitrin` | koşulla indeksle | ≥5 canlı kart (başlangıç önerisi) | 2 → altında |
| `/vitrin/<cardId>` | koşulla indeksle | özet ≥200, kapsam ≥3+1, görsel, sağlayıcı profili koşulu, kopya değil | 0/2 |
| şehir × kategori | **indeksleme — şimdilik üretme** | 5 koşul + elle açılış | aday 0 |
| ilçe × kategori | **indeksleme — şimdilik üretme** | aynı, daha yüksek eşik | aday 0 |
| arama/filtre varyantları | indeksleme (mevcut `noindex, follow`) | — | ✔ |
| rehber/makale | koşulla indeksle (route yok) | yazar/tarih, çift yönlü kategori linki, iddia yok | — |
| sözleşme | indeksleme (`noindex, follow` kalsın) | — | ✔ |
| yardım/KVKK/gizlilik/şartlar | var olduğunda indeksle | gerçek içerik + footer link | yok |
| auth/panel/talep/teklif/mesaj/destek/API | indeksleme (Disallow + noindex) | — | ✔ |

"Koşulla indeksle" satırları bu PR'da hiçbir noindex değişikliği yapmaz; koşul, içerik planının kabul
kriteridir; kod tarafı B2'dedir. Production'da indeks kapısının açık olup olmadığı doğrulanamadı.

## 3. Şehir × kategori — net karar

**Şimdilik üretme.** Otomatik rota (her il/ilçe için dinamik sayfa) **hiç önerilmez**; Google'ın
doorway ("multiple … pages targeted at specific regions or cities that funnel users to one page") ve
scaled content tanımlarına girer. Aday sayfa yalnız beş koşulun tamamıyla, tek tek, elle açılır:

1. o şehir/ilçe için özgün editoryal içerik (şehir adı değiştirilmiş şablon sayılmaz);
2. yeterli güncel arz — başlangıç önerisi: il ≥5 APPROVED sağlayıcı + ≥2 son 90 günde aktif; ilçe ≥3;
3. sayfada ≥3 görünür sağlayıcı/kart (yalnız form değil);
4. statik temiz path, kendi canonical'ı, kategori sayfasından link, sitemap `updatedAt`;
5. eşik düşünce otomatik `noindex, follow` + sitemap'ten çıkış; 30 gün altında kalırsa rota kapanır
   (404, kategoriye redirect **değil**).

Yerel veri eşiği karşılamıyor (en yüksek çift `ev-temizligi` × İstanbul = 3 sağlayıcı; ilçe max 3;
içerik/bileşen yok). Production sayıları bilinmiyor → B1 envanter raporu olmadan aday listesi yapılmaz.
Dijital/uzaktan kategoriler bu modelin hiçbir zaman adayı değildir.

## 4. Minimum indexable profile şartları

| # | Şart | Alan var mı | Eksikse |
| --- | --- | --- | --- |
| P1 | gerçek işletme adı | var | moderasyon |
| P2 | `description` ≥300 karakter (başlangıç önerisi), özgün, iletişim yok | var, 0/3 dolu | panelde doluluk göstergesi / zorunluluk (ürün) |
| P3 | ≥1 ACTIVE kategori | var | — |
| P4 | ≥1 hizmet bölgesi | var | — |
| P5 | kategori etiketleri → kategori sayfası linki | **kod yok** | B3 |
| P6 | görsel (logo/kapak) | **alan yok** | ürün: görsel alanı + moderasyon (B9) |
| P7 | puan özeti eşik üstü **ya da** P2 | var (eşikli) | — (puan zorunlu değil; JSON-LD'ye girmez) |
| P8 | vitrin kartı: özet ≥200, kapsam ≥3/≥1, görsel, kopya değil | alanlar var | kart yazım kılavuzu + minimumlar (ürün) |

Eksikte önce ürün verisi; alan varken boşsa meta `noindex` (robots.txt değil) — B2.

## 5. 90 günlük yayın sırası

| Dönem | İş | Kod gerekir mi |
| --- | --- | --- |
| 0–30 | K1 kategori sayfası içeriği (7; önce klima-servisi, ev-temizligi, klima-montaji) | `description`/görsel hayır; çok bloklu yapı B4 |
| 0–30 | K2 yardım/güven sayfaları (KVKK, gizlilik, şartlar, nasıl çalışır) | B6 |
| 30–60 | K3 kategori rehberleri (7; klima-servisi, ev-temizligi önce) | B5 |
| 30–60 | K4 işletme profili doldurma kampanyası (P2) | kampanya hayır; gösterge B2/ürün |
| 60–90 | K5 vitrin kartı kalitesi (kılavuz + minimumlar) | ürün |
| 60–90 | K6 SSS genişletme + hizmet veren bilgi sayfası | SSS hayır; sayfa B6 |
| 90+ | K7 şehir×kategori aday değerlendirmesi | yalnız §3 koşulları + B1 |

Şablonlar (amaç, zorunlu özgün alanlar, yasaklar, CTA, iç link, güncelleme sahibi) strateji §5.2'de;
iç link haritası §5.4'te (private/teklif/talep/filtre URL'lerine SEO linki yok).

## 6. Ölçüm planı (Search Console kurulunca)

1. Domain property doğrulama; 2. `/sitemap.xml` gönderimi (yerel eşdeğeri 15 URL); 3. Pages raporu:
sitemap URL'leri indexed, varyantlar yalnız "noindex" altında, "Duplicate without user-selected canonical"
= 0; 4. Performance: Web, Query/Page/Country/Device, sayfa regex grupları (`^/categories/`, `^/isletme/`,
`^/vitrin/`), sorgu grupları (marka, bölge, bilgi) — hacim buradan okunur; 5. dönüşüm olayları
(`request_submitted`, `showcase_lead_sent`, `provider_register_started`, `guide_to_category_click`,
`profile_category_click`); 6. URL Inspection örnekleri; 7. haftalık kontrol listesi (7 madde).

30/60/90 gün: hedef sayı yok; 30 = teknik taban + K1/K2; 60 = impressions/pozisyon trendi + rehber
indeksleme + iç link olayları + profil doluluğu; 90 = sınıf bazında organik→talep dönüşümü, "Crawled –
not indexed" trendi, bölge sorgularının çift dağılımı → eşik revizyonu.

Yayın süreci, kalite kontrol listesi, güncelleme kadansı ve indeks kaldırma/redirect karar ağacı
strateji §6.3'te (eşdeğer yoksa 404/410; kategoriye toplama redirect'i yok).

## 7. Ayrı kod backlog'u (bu PR'da uygulanmadı)

B1 arz/içerik envanteri raporu · B2 koşullu noindex (kategori/profil/raf/kart; sitemap aynı predicate) ·
B3 iç linkler (profil etiketi→kategori, kart kicker→kategori, kategori→vitrin) · B4 kategori içerik
blokları (alan/model + admin + render; migration) · B5 rehber route'u + allowlist + sitemap + `Article`
JSON-LD · B6 yardım/güven sayfaları + footer · B7 marka yazımı tek kaynak · B8 kategori adlarında
Türkçe karakter (slug sabit) · B9 profil görsel alanı · B10 vitrin `lastmod` · B11 popüler aramalar →
doğrudan kategori · B12 şehir×kategori route'u (yalnız eşik sağlanınca) · B13 uzaktan/dijital hizmet
ürün kararı · B14 `LocalBusiness` tam adres şartı → şema kapsamı · B15 sözleşme sayfası: noindex kalsın
(kapatıldı).

## 8. Kaynaklar, kalite kapıları, PR/head/CI

Resmî kaynaklar (strateji §2): Search Central spam policies (doorway, scaled content), creating
helpful content, consolidate duplicate URLs, faceted navigation, block indexing (noindex), build
sitemap, structured data policies, review snippet, local business; Search Console yardım: Page
indexing (7440203), Performance (7576553).

Kalite kapıları: docs-only olduğu için `pnpm typecheck/lint/test/build` etkilenmez; CI yine
çalıştırılır ve 3/3 beklenir.

- Taban: `origin/main` @ `e51c950c`; worktree temiz (başlangıçta `git status --short` boş).
- Değişen dosyalar: 2 (yalnız `docs/superpowers/`).
| Alan | Değer |
| --- | --- |
| PR | [#92](https://github.com/umutciftciii/taktic/pull/92) — `claude/seo-002-organic-content-strategy-df74e4` → `main` |
| İlk commit | `1778332c` (iki belge) |
| Head | bu rapor commit'i (PR'daki son commit; CI bu head'de koşar) |
| CI | PR üzerinde `CI` workflow'u 3/3 beklenir; sonuç PR checks sekmesinde |
