# P0 araştırması — Dalga 2 kaynak envanteri

Bu dosya, P0 hizmet araştırmasında **yönlendirici (ROUTER) içermeyen** ve ilk
dalgaya alınmamış 17 hizmetin kaynak verisini taşır. Amacı tek: bir kategori
dalgasını koda çevirirken hangi bilginin doğrulanmış, hangisinin eksik olduğu
diffte görünsün.

Kapsam ve sınırlar:

- Buradaki bütün kategori adları, tanımlar, soru metinleri ve seçenek etiketleri
  **Taktic'in kendi metinleridir**. Araştırma yalnız "bu hizmetin formunda hangi
  bilgi soruluyor" sorusunun cevabı için okunmuştur; hiçbir marka adı, ekran
  metni, görsel veya tasarım kopyalanmamıştır.
- Bu dosya bir çalışma zamanı girdisi değildir. İçe aktarma betiği hiçbir dosya
  okumaz; dalga `prisma/category-import/wave-2.ts` içinde düz TypeScript
  literalleri olarak durur ve bu dönüştürme bir insanın bir kez yaptığı, sonucu
  diffte duran bir inceleme adımıdır.
- Dalganın tamamı `DRAFT` doğar. Taslak bir kategori yalnızca admin panelinde
  görünür; müşteri kataloğuna, arama sonuçlarına ve hizmet veren keşfine
  girmez.

## 1. Teklif kredisi: bilerek boş

Araştırma bu 17 hizmetin hiçbiri için **Taktic'e ait** bir teklif kredisi
belirlememiştir. Kaynakta gözlemlenen tutarlar başka bir pazaryerinin kendi
fiyat kararlarıdır ve Taktic'in kredi ekonomisiyle karşılaştırılabilir değildir.

Bu yüzden 17 kategorinin tamamı `offerCreditCost = NULL` ile açılır. Uydurulmuş
bir sayı, adminin gözünde "fiyatlandırılmış" görünen ama hiçbir karara
dayanmayan bir kategori üretirdi. `NULL` ise hazırlık panelinde açık bir yayın
engeli olarak görünür: *Teklif kredisi tanımsız*.

## 2. Regüle alanlar

İki hizmet, satılabilmesi için mevzuat tarafında ayrıca değerlendirilmesi
gereken alanlara girer:

| Hizmet | Neden |
| --- | --- |
| Beslenme Danışmanlığı | Diyetisyenlik meslek icrası ve tanıtımı düzenlemeye tabidir; hizmet verenin mesleki yeterliliği doğrulanmadan yayına alınamaz. |
| İSG Danışmanlığı | İş sağlığı ve güvenliği hizmeti yetkilendirilmiş kişi ve kuruluşlarca verilir; belge doğrulaması olmadan yayına alınamaz. |

Bu turda yapılan tek şey, ikisinin de admin hazırlık ekranında **"ek uygunluk
incelemesi gerekir"** uyarısı taşımasıdır. Lisans doğrulaması, belge yükleme
akışı ve kategori aktivasyonu bu turun kapsamı dışındadır. Uyarı yalnızca
operatörün gördüğü yüzeyde durur; müşteri, hizmet veren veya anonim ziyaretçi
yüzeyine hiçbir biçimde çıkmaz.

Beslenme Danışmanlığı formunda sağlık durumu, teşhis veya ilaç bilgisi
**sorulmaz**. Talep açık bir metin alanı taşır ve o alanın yardım metni,
sağlıkla ilgili ayrıntının hizmet veren seçildikten sonra doğrudan paylaşılması
gerektiğini söyler.

## 3. Sistem alanına bağlanan sorular

Kaynak formların hepsinde bir "ihtiyacını anlat" adımı vardır. Taktic'te bunun
karşılığı yeni bir soru değil, talebin zaten taşıdığı alandır:

| Sistem alanı | Nerede kullanıldı | Gerekçe |
| --- | --- | --- |
| `DESCRIPTION` | 17 hizmetin tamamı | Her formda zorunlu serbest metin adımı doğrulandı. |
| `PREFERRED_DATE` | Etkinlik Yemek Servisi, Düğün Fotoğrafçılığı | Tarihi olmayan bir teklif bu iki işte anlamsız; tarih talebin kendi `preferredDate` alanıdır. |
| `BUDGET` | Anahtar Teslim Tadilat, Mobil Uygulama Geliştirme | Kaynak formlarda bütçe aralığı ilk eleme sorusu olarak doğrulandı. |
| `ADDRESS` | — | Kaynakta mahalle kırılımını zorunlu kılan doğrulanmış bir form bulunamadı. Uydurmak yerine boş bırakıldı. |

Bağlı soru ayrı bir girdi açmaz ve ikinci bir cevap satırı yazmaz; talebin
mevcut kolonunu adlandırır, açıklar ve bu kategoride zorunlu kılar.

## 4. Koşullu sorular

Yalnızca kaynakta gerçekten koşullu gözlemlenen üç soru alınmıştır. Kısmi
gözlem, tek örneğe dayanan çıkarım veya "muhtemelen koşulludur" değerlendirmesi
bu dalgaya sokulmamıştır.

| Hizmet | Soru | Koşul |
| --- | --- | --- |
| Anahtar Teslim Tadilat | `konut_plani` | `mekan_tipi` = Konut |
| Düğün Fotoğrafçılığı | `dis_cekim_lokasyon` | `cekim_kapsami` içinde Dış çekim |
| Mobil Uygulama Geliştirme | `mevcut_uygulama_notu` | `proje_durumu` = Yayındaki uygulama geliştirilecek **veya** Yayındaki uygulamaya bakım |

Üçü de `ANY` eşleşmesiyle çalışır. `ALL` eşleşmesi için doğrulanmış bir örnek
bulunamadı, o yüzden bu dalgada kullanılmadı.

## 5. Yönlendirici verisi

Bu dalgada tek bir `ROUTER` kategori ve tek bir yönlendirme kuralı yoktur. P0
araştırmasında yönlendirmeli görülen hizmetlerin kırılım listesi eksiktir —
hangi seçeneğin hangi hizmete gittiği kısmen gözlemlenmiştir. Yarım bir
yönlendirme, müşteriyi bir yere ulaşmayan bir soruda bırakır; bu yüzden
yönlendirmeli hizmetler bu dalganın tamamen dışındadır.

## 6. Gruplar

Beş grup zaten Dalga 1 ile taslak olarak açılmıştı ve **tekrar oluşturulmaz**;
bu dalga onların altına yeni hizmet ekler:

- Tadilat ve Yenileme → Anahtar Teslim Tadilat, Banyo Dolabı Üretimi
- Yapı ve Montaj → Çelik Kapı Montajı, Duşakabin Montajı

Beş grup bu dalgayla ilk kez, taslak olarak açılır:

| Grup | Altındaki hizmetler |
| --- | --- |
| Eğitim | Direksiyon Dersi, Gitar Dersi |
| Etkinlik | Etkinlik Yemek Servisi, Düğün Fotoğrafçılığı |
| Sağlık ve Wellness | Beslenme Danışmanlığı |
| Kurumsal ve Danışmanlık | Ön Muhasebe Hizmeti, Marka Tescil Danışmanlığı, Şirket Kuruluş Danışmanlığı, İSG Danışmanlığı |
| Dijital ve Yaratıcı | Arama Motoru Optimizasyonu, Sosyal Medya Yönetimi, Mobil Uygulama Geliştirme, Ürün Fotoğraf Çekimi |

## 7. Hizmet başına doğrulanmış soru şeması

Aşağıdaki tablolar dalganın sözleşmesidir: `wave-2.ts` bunları uygular ve
`apps/api/test/category-import-wave-2.spec.ts` sayıları buradan doğrular.
Sayılara sistem alanına bağlı sorular dahildir.

| Hizmet | Slug | Üst grup | Soru | Not |
| --- | --- | --- | --- | --- |
| Anahtar Teslim Tadilat | `anahtar-teslim-tadilat` | Tadilat ve Yenileme | 8 | 1 koşullu, `BUDGET` bağı |
| Çelik Kapı Montajı | `celik-kapi-montaji` | Yapı ve Montaj | 5 | |
| Duşakabin Montajı | `dusakabin-montaji` | Yapı ve Montaj | 5 | |
| Banyo Dolabı Üretimi | `banyo-dolabi-uretimi` | Tadilat ve Yenileme | 6 | |
| Direksiyon Dersi | `direksiyon-dersi` | Eğitim | 6 | |
| Gitar Dersi | `gitar-dersi` | Eğitim | 7 | |
| Etkinlik Yemek Servisi | `etkinlik-yemek-servisi` | Etkinlik | 7 | `PREFERRED_DATE` bağı |
| Düğün Fotoğrafçılığı | `dugun-fotografciligi` | Etkinlik | 6 | 1 koşullu, `PREFERRED_DATE` bağı |
| Beslenme Danışmanlığı | `beslenme-danismanligi` | Sağlık ve Wellness | 5 | ek uygunluk incelemesi |
| Ön Muhasebe Hizmeti | `on-muhasebe-hizmeti` | Kurumsal ve Danışmanlık | 6 | |
| Marka Tescil Danışmanlığı | `marka-tescil-danismanligi` | Kurumsal ve Danışmanlık | 5 | |
| Şirket Kuruluş Danışmanlığı | `sirket-kurulus-danismanligi` | Kurumsal ve Danışmanlık | 5 | |
| İSG Danışmanlığı | `isg-danismanligi` | Kurumsal ve Danışmanlık | 6 | ek uygunluk incelemesi |
| Arama Motoru Optimizasyonu | `arama-motoru-optimizasyonu` | Dijital ve Yaratıcı | 6 | |
| Sosyal Medya Yönetimi | `sosyal-medya-yonetimi` | Dijital ve Yaratıcı | 6 | |
| Mobil Uygulama Geliştirme | `mobil-uygulama-gelistirme` | Dijital ve Yaratıcı | 7 | 1 koşullu, `BUDGET` bağı |
| Ürün Fotoğraf Çekimi | `urun-fotograf-cekimi` | Dijital ve Yaratıcı | 6 | |

Toplam: **5 yeni taslak grup, 17 taslak hizmet, 102 soru, 3 koşul, 0
yönlendirme kuralı.**

## 8. İçe aktarma

```bash
pnpm db:import:categories:wave-2
```

Ayrı bir komuttur, çünkü Dalga 1 ile Dalga 2 farklı incelemelerden geçmiştir ve
bir operatörün "hangi dalgayı uyguluyorum" sorusuna komutun kendisi cevap
vermelidir. İkisi de aynı idempotent içe aktarıcıyı kullanır: ikinci çalıştırma
kategori, soru, koşul ve kural sayılarını değiştirmez; adminin elle değiştirdiği
durum, teklif kredisi ve elle eklediği sorular olduğu gibi kalır.
