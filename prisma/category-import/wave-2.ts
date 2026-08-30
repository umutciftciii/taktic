import {
  ServiceCategoryKind,
  ServiceCategoryStatus,
  ServiceRequestQuestionSystemField,
  ServiceRequestQuestionType,
} from '@prisma/client';
import type { CategoryDefinition, CategoryWave, QuestionDefinition } from './types';

/**
 * Genişleme dalgası 2 — beş yeni grup ve on yedi hizmet, tamamı TASLAK.
 *
 * P0 araştırmasında yönlendirici içermeyen ve ilk dalgaya alınmamış hizmetler.
 * Kaynak envanteri ve her kararın gerekçesi
 * `docs/research/p0-dalga-2-hizmet-envanteri.md` dosyasındadır.
 *
 * Dalga 1'den ayrılan üç nokta, üçü de bilinçli:
 *
 *   teklif kredisi   Bu on yedi hizmetin hiçbiri için Taktic'e ait bir kredi
 *                    bedeli belirlenmedi, o yüzden hepsi fiyatsız (NULL) doğar.
 *                    Uydurulmuş bir sayı, adminin gözünde fiyatlandırılmış ama
 *                    hiçbir karara dayanmayan bir kategori üretirdi; NULL ise
 *                    hazırlık panelinde açık bir yayın engelidir.
 *   regüle alanlar   Beslenme Danışmanlığı ve İSG Danışmanlığı taslak olarak
 *                    eklenir ama admin hazırlık ekranında ek uygunluk incelemesi
 *                    uyarısı taşır. Uyarının kaynağı admin uygulamasındaki slug
 *                    listesidir; API bu alanı hiçbir yanıtta taşımaz, dolayısıyla
 *                    public veya hizmet veren yüzeyine sızacak bir alan yoktur.
 *   mevcut gruplar   Tadilat ve Yenileme ile Yapı ve Montaj Dalga 1'de açıldı;
 *                    bu dosya onları yeniden tanımlamaz, yalnızca altlarına
 *                    hizmet asar. İçe aktarıcı eksik üst kategoriyi veritabanından
 *                    slug ile bulur.
 *
 * Bu dalgada tek bir ROUTER kategori, tek bir yönlendirme kuralı yoktur:
 * araştırmadaki yönlendirmeli hizmetlerin kırılımı eksiktir ve yarım bir
 * yönlendirme müşteriyi hiçbir yere çıkmayan bir soruda bırakır.
 *
 * Metinler Taktic'e aittir. Hiçbir kategori adı, tanımı, soru metni veya seçenek
 * etiketi bir kaynaktan kopyalanmamıştır.
 */

/** Dalga 1'de açılmış, bu dalganın yalnızca altına hizmet astığı gruplar. */
const RENOVATION_GROUP = 'tadilat-ve-yenileme';
const INSTALLATION_GROUP = 'yapi-ve-montaj';

/**
 * Her hizmetin sonunda duran zorunlu serbest metin.
 *
 * Dalga 1'deki ile aynı gerekçe: bu yeni bir soru değil, talebin zaten taşıdığı
 * `description` alanıdır. `DESCRIPTION` bağı o alanı bu kategoride zorunlu kılar
 * ve ona kategoriye özgü bir başlık verir; aynı metin formda iki kez sorulmaz ve
 * cevap satırına ikinci bir kopya yazılmaz.
 */
function jobDescription(sortOrder: number, label: string, helpText?: string): QuestionDefinition {
  return {
    key: 'is_detayi',
    label,
    helpText,
    type: ServiceRequestQuestionType.TEXTAREA,
    isRequired: true,
    sortOrder,
    systemField: ServiceRequestQuestionSystemField.DESCRIPTION,
  };
}

/**
 * Bütçe aralığı.
 *
 * Yalnız iki hizmette: kaynak formlarda bütçenin ilk eleme sorusu olduğu
 * doğrulanan anahtar teslim tadilat ve mobil uygulama projelerinde. `BUDGET`
 * bağı talebin kendi `budgetMin`/`budgetMax` alanlarını adlandırır ve zorunlu
 * kılar — yeni bir kolon veya ikinci bir cevap satırı üretmeden.
 */
function projectBudget(sortOrder: number, label: string, helpText: string): QuestionDefinition {
  return {
    key: 'butce_araligi',
    label,
    helpText,
    type: ServiceRequestQuestionType.NUMBER,
    isRequired: true,
    sortOrder,
    systemField: ServiceRequestQuestionSystemField.BUDGET,
  };
}

/**
 * Etkinlik tarihi.
 *
 * Tarihsiz bir teklif bu iki işte anlamsızdır: hizmet verenin o gün müsait olup
 * olmadığı fiyatın kendisidir. `PREFERRED_DATE` bağı talebin kendi tarih alanını
 * zorunlu kılar.
 */
function eventDate(sortOrder: number, label: string, helpText: string): QuestionDefinition {
  return {
    key: 'etkinlik_tarihi',
    label,
    helpText,
    type: ServiceRequestQuestionType.DATE,
    isRequired: true,
    sortOrder,
    systemField: ServiceRequestQuestionSystemField.PREFERRED_DATE,
  };
}

function option(key: string, label: string) {
  return { key, label };
}

const groups: CategoryDefinition[] = [
  {
    slug: 'egitim',
    name: 'Eğitim',
    description: 'Birebir ders, kurs ve beceri eğitimi hizmetleri.',
    kind: ServiceCategoryKind.GROUP,
    status: ServiceCategoryStatus.DRAFT,
    sortOrder: 150,
    iconKey: 'book',
  },
  {
    slug: 'etkinlik',
    name: 'Etkinlik',
    description: 'Organizasyon, ikram ve çekim gibi etkinlik günü hizmetleri.',
    kind: ServiceCategoryKind.GROUP,
    status: ServiceCategoryStatus.DRAFT,
    sortOrder: 160,
    iconKey: 'sparkles',
  },
  {
    slug: 'saglik-ve-wellness',
    name: 'Sağlık ve Wellness',
    description: 'Kişisel iyilik hali ve yaşam düzeni danışmanlıkları.',
    kind: ServiceCategoryKind.GROUP,
    status: ServiceCategoryStatus.DRAFT,
    sortOrder: 170,
    iconKey: 'drop',
  },
  {
    slug: 'kurumsal-ve-danismanlik',
    name: 'Kurumsal ve Danışmanlık',
    description: 'İşletmelerin kuruluş, mevzuat ve idari süreç ihtiyaçları.',
    kind: ServiceCategoryKind.GROUP,
    status: ServiceCategoryStatus.DRAFT,
    sortOrder: 180,
    iconKey: 'box',
  },
  {
    slug: 'dijital-ve-yaratici',
    name: 'Dijital ve Yaratıcı',
    description: 'Dijital görünürlük, yazılım ve içerik üretimi hizmetleri.',
    kind: ServiceCategoryKind.GROUP,
    status: ServiceCategoryStatus.DRAFT,
    sortOrder: 190,
    iconKey: 'bolt',
  },
];

/** Dalga 1'de açılmış "Tadilat ve Yenileme" grubuna eklenenler. */
const renovation: CategoryDefinition[] = [
  {
    slug: 'anahtar-teslim-tadilat',
    name: 'Anahtar Teslim Tadilat',
    description:
      'Konut veya işyerinin tesisattan boyaya kadar tek elden yenilenmesi.',
    kind: ServiceCategoryKind.LEAF,
    // Open to applications from the day it lands: this wave exists to be
    // staffed before it is released, and a draft nobody may apply to
    // collects nobody. Groups and routers stay closed — neither is work.
    providerEnrollmentOpen: true,
    status: ServiceCategoryStatus.DRAFT,
    parentSlug: RENOVATION_GROUP,
    sortOrder: 124,
    iconKey: 'brush',
    questions: [
      {
        key: 'mekan_tipi',
        label: 'Tadilat hangi tip mekanda yapılacak?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 10,
        options: [
          option('konut', 'Konut'),
          option('isyeri', 'İşyeri'),
          option('ortak_alan', 'Bina ortak alanı'),
        ],
      },
      {
        key: 'konut_plani',
        label: 'Konutun oda planı nedir?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 20,
        options: [
          option('plan_1_1', '1+1'),
          option('plan_2_1', '2+1'),
          option('plan_3_1', '3+1'),
          option('plan_4_1', '4+1'),
          option('plan_5_1_ustu', '5+1 ve üzeri'),
        ],
        conditions: [{ sourceQuestionKey: 'mekan_tipi', expectedValues: ['konut'] }],
      },
      {
        key: 'alan_m2',
        label: 'Tadilat yapılacak alan yaklaşık kaç m²?',
        helpText: 'En yakın değeri seçmeniz yeterli.',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 30,
        options: [
          option('m2_50_alti', '50 m² ve altı'),
          option('m2_80', '80 m²'),
          option('m2_100', '100 m²'),
          option('m2_150', '150 m²'),
          option('m2_200', '200 m²'),
          option('m2_300', '300 m²'),
          option('m2_300_ustu', '300 m² ve üzeri'),
        ],
      },
      {
        key: 'kapsam',
        label: 'Hangi işler kapsama girsin?',
        helpText: 'Birden fazla seçebilirsiniz.',
        type: ServiceRequestQuestionType.MULTI_SELECT,
        isRequired: true,
        sortOrder: 40,
        options: [
          option('tesisat', 'Su ve ısıtma tesisatı'),
          option('elektrik', 'Elektrik tesisatı'),
          option('zemin', 'Zemin kaplama'),
          option('duvar_boya', 'Duvar ve boya'),
          option('mutfak', 'Mutfak yenileme'),
          option('banyo', 'Banyo yenileme'),
          option('alcipan', 'Alçıpan ve asma tavan'),
          option('kapi_pencere', 'Kapı ve pencere'),
          option('diger', 'Diğer'),
        ],
      },
      {
        key: 'mevcut_durum',
        label: 'Mekanın bugünkü durumu nedir?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 50,
        options: [
          option('bos', 'Boş, içeride eşya yok'),
          option('esyali_bosaltilacak', 'Eşyalı, iş öncesi boşaltılacak'),
          option('kullanimda', 'Kullanımda, iş sırasında oturulacak'),
        ],
      },
      {
        key: 'malzeme',
        label: 'Malzeme kime ait olsun?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 60,
        options: [
          option('dahil', 'Malzeme fiyata dahil olsun'),
          option('haric', 'Malzeme hariç, yalnız işçilik'),
          option('kararsizim', 'İki seçeneği de görmek istiyorum'),
        ],
      },
      projectBudget(
        70,
        'Bu tadilat için ayırdığınız bütçe aralığı',
        'Yaklaşık bir aralık vermeniz, size uygun kapsamda teklif gelmesini sağlar.',
      ),
      jobDescription(80, 'Yapılmasını istediğiniz işi kısaca anlatın'),
    ],
  },
  {
    slug: 'banyo-dolabi-uretimi',
    name: 'Banyo Dolabı Üretimi',
    description: 'Ölçüye göre banyo dolabı üretimi ve isteğe bağlı montajı.',
    kind: ServiceCategoryKind.LEAF,
    // Open to applications from the day it lands: this wave exists to be
    // staffed before it is released, and a draft nobody may apply to
    // collects nobody. Groups and routers stay closed — neither is work.
    providerEnrollmentOpen: true,
    status: ServiceCategoryStatus.DRAFT,
    parentSlug: RENOVATION_GROUP,
    sortOrder: 125,
    iconKey: 'tool',
    questions: [
      {
        key: 'dolap_adedi',
        label: 'Kaç adet banyo dolabı yapılacak?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 10,
        options: [
          option('adet_1', '1'),
          option('adet_2', '2'),
          option('adet_3_ustu', '3 ve üzeri'),
        ],
      },
      {
        key: 'genislik',
        label: 'Dolabın genişliği yaklaşık ne kadar?',
        helpText: 'Ölçü almadıysanız en yakın değeri seçin.',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 20,
        options: [
          option('cm_60_alti', '60 cm ve altı'),
          option('cm_60_80', '60–80 cm'),
          option('cm_80_100', '80–100 cm'),
          option('cm_100_120', '100–120 cm'),
          option('cm_120_ustu', '120 cm ve üzeri'),
        ],
      },
      {
        key: 'govde_malzemesi',
        label: 'Gövde hangi malzemeden olsun?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 30,
        options: [
          option('mdf_lake', 'Lake MDF'),
          option('suya_dayanikli_mdf', 'Suya dayanıklı MDF'),
          option('pvc', 'PVC'),
          option('masif', 'Masif ahşap'),
          option('oneri_istiyorum', 'Öneri istiyorum'),
        ],
      },
      {
        key: 'dahil_urunler',
        label: 'Dolapla birlikte ne gelsin?',
        helpText: 'Birden fazla seçebilirsiniz.',
        type: ServiceRequestQuestionType.MULTI_SELECT,
        isRequired: true,
        sortOrder: 40,
        options: [
          option('lavabo', 'Lavabo'),
          option('ayna', 'Ayna'),
          option('ayna_dolabi', 'Üst ayna dolabı'),
          option('aydinlatma', 'Aydınlatma'),
          option('batarya', 'Batarya'),
          option('yalniz_dolap', 'Yalnız dolap'),
        ],
      },
      {
        key: 'montaj',
        label: 'Montaj da yapılsın mı?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 50,
        options: [
          option('evet', 'Evet, montaj dahil olsun'),
          option('hayir', 'Hayır, yalnız üretim'),
        ],
      },
      jobDescription(60, 'Banyonuzu ve dolaptan beklentinizi kısaca anlatın'),
    ],
  },
];

/** Dalga 1'de açılmış "Yapı ve Montaj" grubuna eklenenler. */
const installation: CategoryDefinition[] = [
  {
    slug: 'celik-kapi-montaji',
    name: 'Çelik Kapı Montajı',
    description: 'Çelik kapının yerine takılması, eski kapının sökülmesi.',
    kind: ServiceCategoryKind.LEAF,
    // Open to applications from the day it lands: this wave exists to be
    // staffed before it is released, and a draft nobody may apply to
    // collects nobody. Groups and routers stay closed — neither is work.
    providerEnrollmentOpen: true,
    status: ServiceCategoryStatus.DRAFT,
    parentSlug: INSTALLATION_GROUP,
    sortOrder: 142,
    iconKey: 'tool',
    questions: [
      {
        key: 'kapi_adedi',
        label: 'Kaç adet çelik kapı takılacak?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 10,
        options: [
          option('adet_1', '1'),
          option('adet_2', '2'),
          option('adet_3', '3'),
          option('adet_4_5', '4–5'),
          option('adet_6_ustu', '6 ve üzeri'),
        ],
      },
      {
        key: 'is_tipi',
        label: 'Hangi işi istiyorsunuz?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 20,
        options: [
          option('urun_ve_montaj', 'Kapı hizmet veren tarafından temin edilsin ve takılsın'),
          option('yalniz_montaj', 'Kapı bende var, yalnız montaj yapılsın'),
          option('degisim', 'Eski kapı sökülsün, yerine yenisi takılsın'),
        ],
      },
      {
        key: 'kapi_yeri',
        label: 'Kapı nereye takılacak?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 30,
        options: [
          option('daire_giris', 'Daire girişi'),
          option('bina_giris', 'Bina girişi'),
          option('isyeri', 'İşyeri'),
          option('depo', 'Depo veya teknik alan'),
          option('diger', 'Diğer'),
        ],
      },
      {
        key: 'olcu_durumu',
        label: 'Kapı boşluğunun ölçüsü belli mi?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 40,
        options: [
          option('olculu', 'Ölçüleri biliyorum'),
          option('olcu_alinsin', 'Yerinde ölçü alınsın'),
        ],
      },
      jobDescription(50, 'Kapı ve montaj yeriyle ilgili kısa bir not'),
    ],
  },
  {
    slug: 'dusakabin-montaji',
    name: 'Duşakabin Montajı',
    description: 'Duşakabinin kurulumu, değişimi veya sızdırmazlık onarımı.',
    kind: ServiceCategoryKind.LEAF,
    // Open to applications from the day it lands: this wave exists to be
    // staffed before it is released, and a draft nobody may apply to
    // collects nobody. Groups and routers stay closed — neither is work.
    providerEnrollmentOpen: true,
    status: ServiceCategoryStatus.DRAFT,
    parentSlug: INSTALLATION_GROUP,
    sortOrder: 143,
    iconKey: 'drop',
    questions: [
      {
        key: 'is_tipi',
        label: 'Hangi işi istiyorsunuz?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 10,
        options: [
          option('yeni_montaj', 'Yeni duşakabin kurulsun'),
          option('degisim', 'Eski duşakabin sökülsün, yenisi takılsın'),
          option('onarim', 'Mevcut duşakabin onarılsın'),
        ],
      },
      {
        key: 'kabin_tipi',
        label: 'Hangi tip duşakabin?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 20,
        options: [
          option('kose', 'Köşe duşakabin'),
          option('dikdortgen', 'Dikdörtgen duşakabin'),
          option('oval', 'Oval duşakabin'),
          option('tek_panel', 'Tek panel duş bölmesi'),
          option('bilinmiyor', 'Emin değilim, öneri istiyorum'),
        ],
      },
      {
        key: 'duvar_yapisi',
        label: 'Montaj yapılacak duvar hangi malzemeden?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 30,
        options: [
          option('seramik', 'Seramik'),
          option('mermer_granit', 'Mermer veya granit'),
          option('alcipan', 'Alçıpan'),
          option('beton', 'Beton veya tuğla'),
          option('bilinmiyor', 'Bilmiyorum'),
        ],
      },
      {
        key: 'urun_durumu',
        label: 'Duşakabin sizde mi?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 40,
        options: [
          option('bende_var', 'Ürün bende, yalnız montaj gerekiyor'),
          option('satin_alinacak', 'Ürün de hizmet veren tarafından temin edilsin'),
        ],
      },
      jobDescription(50, 'Banyonuzu ve istediğiniz işi kısaca anlatın'),
    ],
  },
];

const education: CategoryDefinition[] = [
  {
    slug: 'direksiyon-dersi',
    name: 'Direksiyon Dersi',
    description: 'Sınav öncesi veya sonrası birebir direksiyon pratiği.',
    kind: ServiceCategoryKind.LEAF,
    // Open to applications from the day it lands: this wave exists to be
    // staffed before it is released, and a draft nobody may apply to
    // collects nobody. Groups and routers stay closed — neither is work.
    providerEnrollmentOpen: true,
    status: ServiceCategoryStatus.DRAFT,
    parentSlug: 'egitim',
    sortOrder: 151,
    iconKey: 'book',
    questions: [
      {
        key: 'ehliyet_durumu',
        label: 'Ehliyet durumunuz nedir?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 10,
        options: [
          option('ehliyet_yok', 'Ehliyetim yok, sınava hazırlanıyorum'),
          option('yeni_ehliyet', 'Ehliyetim yeni, pratik yapmak istiyorum'),
          option('uzun_ara', 'Ehliyetim var ama uzun süredir kullanmıyorum'),
        ],
      },
      {
        key: 'vites_tipi',
        label: 'Hangi vites tipinde ders istiyorsunuz?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 20,
        options: [
          option('manuel', 'Manuel'),
          option('otomatik', 'Otomatik'),
          option('farketmez', 'Farketmez'),
        ],
      },
      {
        key: 'ders_sayisi',
        label: 'Yaklaşık kaç ders planlıyorsunuz?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 30,
        options: [
          option('ders_1_2', '1–2 ders'),
          option('ders_3_5', '3–5 ders'),
          option('ders_6_10', '6–10 ders'),
          option('ders_10_ustu', '10 dersten fazla'),
          option('kararsizim', 'Kararsızım, öneri istiyorum'),
        ],
      },
      {
        key: 'arac_durumu',
        label: 'Ders hangi araçla yapılacak?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 40,
        options: [
          option('egitmen_araci', 'Eğitmenin aracıyla'),
          option('kendi_aracim', 'Kendi aracımla'),
          option('farketmez', 'Farketmez'),
        ],
      },
      {
        key: 'uygun_zaman',
        label: 'Ders için uygun zamanlarınız hangileri?',
        helpText: 'Birden fazla seçebilirsiniz.',
        type: ServiceRequestQuestionType.MULTI_SELECT,
        isRequired: true,
        sortOrder: 50,
        options: [
          option('hafta_ici_gunduz', 'Hafta içi gündüz'),
          option('hafta_ici_aksam', 'Hafta içi akşam'),
          option('hafta_sonu', 'Hafta sonu'),
        ],
      },
      jobDescription(60, 'Beklentinizi ve varsa zorlandığınız konuları anlatın'),
    ],
  },
  {
    slug: 'gitar-dersi',
    name: 'Gitar Dersi',
    description: 'Her seviyeye birebir gitar dersi; adreste, eğitmende veya çevrimiçi.',
    kind: ServiceCategoryKind.LEAF,
    // Open to applications from the day it lands: this wave exists to be
    // staffed before it is released, and a draft nobody may apply to
    // collects nobody. Groups and routers stay closed — neither is work.
    providerEnrollmentOpen: true,
    status: ServiceCategoryStatus.DRAFT,
    parentSlug: 'egitim',
    sortOrder: 152,
    iconKey: 'book',
    questions: [
      {
        key: 'ogrenci',
        label: 'Ders kim için?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 10,
        options: [
          option('yetiskin', 'Yetişkin'),
          option('ergen', '13–17 yaş'),
          option('cocuk', '12 yaş ve altı'),
        ],
      },
      {
        key: 'seviye',
        label: 'Mevcut seviyeniz nedir?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 20,
        options: [
          option('sifir', 'Hiç çalmadım'),
          option('baslangic', 'Başlangıç'),
          option('orta', 'Orta'),
          option('ileri', 'İleri'),
        ],
      },
      {
        key: 'gitar_tipi',
        label: 'Hangi gitarla çalışmak istiyorsunuz?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 30,
        options: [
          option('klasik', 'Klasik gitar'),
          option('akustik', 'Akustik gitar'),
          option('elektro', 'Elektro gitar'),
          option('bas', 'Bas gitar'),
          option('kararsizim', 'Kararsızım, öneri istiyorum'),
        ],
      },
      {
        key: 'ders_yeri',
        label: 'Ders nerede yapılsın?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 40,
        options: [
          option('ogrenci_adresi', 'Benim adresimde'),
          option('egitmen_yeri', 'Eğitmenin yerinde'),
          option('online', 'Çevrimiçi'),
          option('farketmez', 'Farketmez'),
        ],
      },
      {
        key: 'ders_sikligi',
        label: 'Ders sıklığı ne olsun?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 50,
        options: [
          option('haftada_1', 'Haftada 1'),
          option('haftada_2', 'Haftada 2'),
          option('haftada_3_ustu', 'Haftada 3 ve üzeri'),
          option('kararsizim', 'Kararsızım'),
        ],
      },
      {
        key: 'enstruman',
        label: 'Gitarınız var mı?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 60,
        options: [
          option('var', 'Var'),
          option('alacagim', 'Yok, alacağım'),
          option('oneri_istiyorum', 'Yok, öneri istiyorum'),
        ],
      },
      jobDescription(70, 'Hedefinizi ve çalmak istediğiniz parçaları kısaca anlatın'),
    ],
  },
];

const events: CategoryDefinition[] = [
  {
    slug: 'etkinlik-yemek-servisi',
    name: 'Etkinlik Yemek Servisi',
    description: 'Davet, tören ve kurumsal etkinlikler için yemek ve ikram servisi.',
    kind: ServiceCategoryKind.LEAF,
    // Open to applications from the day it lands: this wave exists to be
    // staffed before it is released, and a draft nobody may apply to
    // collects nobody. Groups and routers stay closed — neither is work.
    providerEnrollmentOpen: true,
    status: ServiceCategoryStatus.DRAFT,
    parentSlug: 'etkinlik',
    sortOrder: 161,
    iconKey: 'sparkles',
    questions: [
      {
        key: 'etkinlik_tipi',
        label: 'Nasıl bir etkinlik düzenliyorsunuz?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 10,
        options: [
          option('dogum_gunu', 'Doğum günü'),
          option('nisan_dugun', 'Nişan veya düğün'),
          option('kurumsal', 'Kurumsal toplantı veya eğitim'),
          option('acilis', 'Açılış veya lansman'),
          option('aile_daveti', 'Aile daveti'),
          option('diger', 'Diğer'),
        ],
      },
      {
        key: 'kisi_sayisi',
        label: 'Kaç kişilik servis gerekiyor?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 20,
        options: [
          option('kisi_25_alti', '25 kişi ve altı'),
          option('kisi_25_50', '25–50 kişi'),
          option('kisi_50_100', '50–100 kişi'),
          option('kisi_100_200', '100–200 kişi'),
          option('kisi_200_400', '200–400 kişi'),
          option('kisi_400_ustu', '400 kişi ve üzeri'),
        ],
      },
      {
        key: 'servis_sekli',
        label: 'Servis nasıl olsun?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 30,
        options: [
          option('acik_bufe', 'Açık büfe'),
          option('masaya_servis', 'Masaya servis'),
          option('kokteyl', 'Kokteyl ve ayaküstü ikram'),
          option('paket_teslim', 'Paket teslim, servis yok'),
        ],
      },
      {
        key: 'menu_kapsami',
        label: 'Menüde neler olsun?',
        helpText: 'Birden fazla seçebilirsiniz.',
        type: ServiceRequestQuestionType.MULTI_SELECT,
        isRequired: true,
        sortOrder: 40,
        options: [
          option('sicak_yemek', 'Sıcak yemek'),
          option('soguk_meze', 'Soğuk meze'),
          option('salata', 'Salata'),
          option('tatli', 'Tatlı'),
          option('pasta', 'Pasta'),
          option('icecek', 'İçecek'),
          option('cay_kahve', 'Çay ve kahve'),
        ],
      },
      {
        key: 'ekipman',
        label: 'Hangi ekipman ve hizmet gerekli?',
        helpText: 'Birden fazla seçebilirsiniz.',
        type: ServiceRequestQuestionType.MULTI_SELECT,
        isRequired: true,
        sortOrder: 50,
        options: [
          option('masa_sandalye', 'Masa ve sandalye'),
          option('servis_ekibi', 'Servis ekibi'),
          option('sunum_ekipmani', 'Sunum ve ısıtma ekipmanı'),
          option('hicbiri', 'Hiçbiri, yalnız yemek'),
        ],
      },
      eventDate(60, 'Etkinlik tarihi', 'Kesinleşmemişse en yakın tahmininizi girin.'),
      jobDescription(70, 'Etkinliği ve mekanı kısaca anlatın'),
    ],
  },
  {
    slug: 'dugun-fotografciligi',
    name: 'Düğün Fotoğrafçılığı',
    description: 'Nişan, dış çekim ve düğün günü fotoğraf çekimi.',
    kind: ServiceCategoryKind.LEAF,
    // Open to applications from the day it lands: this wave exists to be
    // staffed before it is released, and a draft nobody may apply to
    // collects nobody. Groups and routers stay closed — neither is work.
    providerEnrollmentOpen: true,
    status: ServiceCategoryStatus.DRAFT,
    parentSlug: 'etkinlik',
    sortOrder: 162,
    iconKey: 'sparkles',
    questions: [
      {
        key: 'cekim_kapsami',
        label: 'Hangi çekimleri istiyorsunuz?',
        helpText: 'Birden fazla seçebilirsiniz.',
        type: ServiceRequestQuestionType.MULTI_SELECT,
        isRequired: true,
        sortOrder: 10,
        options: [
          option('soz_nisan', 'Söz veya nişan'),
          option('dis_cekim', 'Dış çekim'),
          option('gelin_hazirlik', 'Gelin hazırlık'),
          option('dugun_gunu', 'Düğün günü'),
          option('after_party', 'After party'),
        ],
      },
      {
        key: 'dis_cekim_lokasyon',
        label: 'Dış çekim nerede yapılacak?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 20,
        options: [
          option('sehir_ici', 'Şehir içi'),
          option('sehir_disi', 'Şehir dışı'),
          option('karar_verilmedi', 'Henüz karar vermedik'),
        ],
        conditions: [{ sourceQuestionKey: 'cekim_kapsami', expectedValues: ['dis_cekim'] }],
      },
      {
        key: 'teslim_bicimi',
        label: 'Çekim sonunda ne teslim edilsin?',
        helpText: 'Birden fazla seçebilirsiniz.',
        type: ServiceRequestQuestionType.MULTI_SELECT,
        isRequired: true,
        sortOrder: 30,
        options: [
          option('dijital_arsiv', 'Dijital arşiv'),
          option('basili_album', 'Basılı albüm'),
          option('duvar_kadraji', 'Duvar kadrajı'),
          option('video_klip', 'Video klip'),
        ],
      },
      {
        key: 'video',
        label: 'Video çekimi de olsun mu?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 40,
        options: [
          option('evet', 'Evet'),
          option('hayir', 'Hayır'),
          option('kararsizim', 'Kararsızım, fiyatını görmek istiyorum'),
        ],
      },
      eventDate(50, 'Düğün tarihi', 'Kesinleşmemişse en yakın tahmininizi girin.'),
      jobDescription(60, 'Düğün planınızı ve beklentinizi kısaca anlatın'),
    ],
  },
];

const wellness: CategoryDefinition[] = [
  {
    slug: 'beslenme-danismanligi',
    name: 'Beslenme Danışmanlığı',
    description: 'Kişiye özel beslenme planı ve düzenli takip görüşmeleri.',
    kind: ServiceCategoryKind.LEAF,
    // Open to applications from the day it lands: this wave exists to be
    // staffed before it is released, and a draft nobody may apply to
    // collects nobody. Groups and routers stay closed — neither is work.
    providerEnrollmentOpen: true,
    status: ServiceCategoryStatus.DRAFT,
    parentSlug: 'saglik-ve-wellness',
    sortOrder: 171,
    iconKey: 'drop',
    questions: [
      {
        key: 'danisan',
        label: 'Danışmanlık kimin için?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 10,
        options: [
          option('kendim', 'Kendim için'),
          option('cocugum', 'Çocuğum için'),
          option('aile_uyesi', 'Bir aile yakınım için'),
        ],
      },
      {
        key: 'hedef',
        label: 'Hangi hedefle başvuruyorsunuz?',
        helpText: 'Birden fazla seçebilirsiniz.',
        type: ServiceRequestQuestionType.MULTI_SELECT,
        isRequired: true,
        sortOrder: 20,
        options: [
          option('kilo_verme', 'Kilo verme'),
          option('kilo_alma', 'Kilo alma'),
          option('sporcu', 'Sporcu beslenmesi'),
          option('aliskanlik', 'Sağlıklı beslenme alışkanlığı'),
          option('hamilelik_emzirme', 'Hamilelik veya emzirme dönemi'),
          option('diger', 'Diğer'),
        ],
      },
      {
        key: 'gorusme_sekli',
        label: 'Görüşmeler nasıl yapılsın?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 30,
        options: [
          option('yuz_yuze', 'Yüz yüze'),
          option('online', 'Çevrimiçi'),
          option('farketmez', 'Farketmez'),
        ],
      },
      {
        key: 'program_suresi',
        label: 'Ne kadar süreli bir program düşünüyorsunuz?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 40,
        options: [
          option('tek_gorusme', 'Tek görüşme'),
          option('ay_1', '1 ay'),
          option('ay_3', '3 ay'),
          option('ay_6_ustu', '6 ay ve üzeri'),
          option('kararsizim', 'Kararsızım'),
        ],
      },
      // Sağlık durumu, teşhis veya ilaç bilgisi bilerek sorulmaz: talep, hizmet
      // veren seçilmeden önce birden fazla işletmeye açılan bir kayıttır ve
      // oraya yazılan sağlık bilgisi geri alınamaz. Yardım metni bu ayrımı
      // müşteriye açıkça söyler.
      jobDescription(
        50,
        'Beklentinizi kısaca anlatın',
        'Sağlık durumunuzla ilgili ayrıntıları burada paylaşmanız gerekmez; hizmet vereni seçtikten sonra doğrudan iletebilirsiniz.',
      ),
    ],
  },
];

const business: CategoryDefinition[] = [
  {
    slug: 'on-muhasebe-hizmeti',
    name: 'Ön Muhasebe Hizmeti',
    description: 'Fatura, cari ve mutabakat gibi günlük muhasebe işlerinin yürütülmesi.',
    kind: ServiceCategoryKind.LEAF,
    // Open to applications from the day it lands: this wave exists to be
    // staffed before it is released, and a draft nobody may apply to
    // collects nobody. Groups and routers stay closed — neither is work.
    providerEnrollmentOpen: true,
    status: ServiceCategoryStatus.DRAFT,
    parentSlug: 'kurumsal-ve-danismanlik',
    sortOrder: 181,
    iconKey: 'box',
    questions: [
      {
        key: 'isletme_tipi',
        label: 'İşletmenizin türü nedir?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 10,
        options: [
          option('sahis', 'Şahıs işletmesi'),
          option('limited', 'Limited şirket'),
          option('anonim', 'Anonim şirket'),
          option('kurulus_asamasinda', 'Henüz kurulmadı'),
        ],
      },
      {
        key: 'calisan_sayisi',
        label: 'Kaç çalışanınız var?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 20,
        options: [
          option('calisan_yok', 'Çalışanım yok'),
          option('calisan_1_5', '1–5 çalışan'),
          option('calisan_6_15', '6–15 çalışan'),
          option('calisan_16_50', '16–50 çalışan'),
          option('calisan_50_ustu', '50 çalışan ve üzeri'),
        ],
      },
      {
        key: 'kapsam',
        label: 'Hangi işleri devretmek istiyorsunuz?',
        helpText: 'Birden fazla seçebilirsiniz.',
        type: ServiceRequestQuestionType.MULTI_SELECT,
        isRequired: true,
        sortOrder: 30,
        options: [
          option('fatura_kaydi', 'Fatura kaydı'),
          option('cari_takip', 'Cari hesap takibi'),
          option('banka_mutabakat', 'Banka mutabakatı'),
          option('bordro_hazirlik', 'Bordro hazırlığı'),
          option('e_belge', 'E-fatura ve e-arşiv işlemleri'),
          option('raporlama', 'Dönemsel raporlama'),
          option('diger', 'Diğer'),
        ],
      },
      {
        key: 'aylik_belge',
        label: 'Ayda yaklaşık kaç belge işleniyor?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 40,
        options: [
          option('belge_50_alti', '50 belgeden az'),
          option('belge_50_150', '50–150 belge'),
          option('belge_150_400', '150–400 belge'),
          option('belge_400_ustu', '400 belgeden fazla'),
          option('bilmiyorum', 'Bilmiyorum'),
        ],
      },
      {
        key: 'calisma_sekli',
        label: 'Çalışma şekli ne olsun?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 50,
        options: [
          option('uzaktan', 'Uzaktan'),
          option('yerinde', 'İşyerimde'),
          option('farketmez', 'Farketmez'),
        ],
      },
      jobDescription(60, 'İşletmenizi ve beklentinizi kısaca anlatın'),
    ],
  },
  {
    slug: 'marka-tescil-danismanligi',
    name: 'Marka Tescil Danışmanlığı',
    description: 'Marka araştırması, başvuru dosyalama ve süreç takibi.',
    kind: ServiceCategoryKind.LEAF,
    // Open to applications from the day it lands: this wave exists to be
    // staffed before it is released, and a draft nobody may apply to
    // collects nobody. Groups and routers stay closed — neither is work.
    providerEnrollmentOpen: true,
    status: ServiceCategoryStatus.DRAFT,
    parentSlug: 'kurumsal-ve-danismanlik',
    sortOrder: 182,
    iconKey: 'box',
    questions: [
      {
        key: 'basvuru_sahibi',
        label: 'Başvuru kimin adına yapılacak?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 10,
        options: [
          option('sahis', 'Şahıs'),
          option('sirket', 'Şirket'),
          option('kurulus_asamasinda', 'Şirket henüz kurulmadı'),
        ],
      },
      {
        key: 'marka_tipi',
        label: 'Tescil edilecek marka nedir?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 20,
        options: [
          option('kelime', 'Yalnız isim'),
          option('logo', 'Yalnız logo'),
          option('kelime_logo', 'İsim ve logo birlikte'),
          option('kararsizim', 'Kararsızım'),
        ],
      },
      {
        key: 'hizmet_kapsami',
        label: 'Hangi adımlarda destek istiyorsunuz?',
        helpText: 'Birden fazla seçebilirsiniz.',
        type: ServiceRequestQuestionType.MULTI_SELECT,
        isRequired: true,
        sortOrder: 30,
        options: [
          option('benzerlik_arastirmasi', 'Benzerlik araştırması'),
          option('sinif_belirleme', 'Sınıf belirleme'),
          option('basvuru_dosyalama', 'Başvuru dosyalama'),
          option('itiraz_yonetimi', 'İtiraz ve yayına itiraz yönetimi'),
          option('yenileme', 'Yenileme'),
          option('devir', 'Devir ve lisans işlemleri'),
        ],
      },
      {
        key: 'kapsam_bolge',
        label: 'Tescil nerede geçerli olsun?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 40,
        options: [
          option('turkiye', 'Türkiye'),
          option('avrupa', 'Avrupa'),
          option('uluslararasi', 'Uluslararası'),
          option('kararsizim', 'Kararsızım'),
        ],
      },
      jobDescription(50, 'Markanızı ve mevcut durumu kısaca anlatın'),
    ],
  },
  {
    slug: 'sirket-kurulus-danismanligi',
    name: 'Şirket Kuruluş Danışmanlığı',
    description: 'Şirket türü seçimi, kuruluş işlemleri ve ilk dönem yönlendirmesi.',
    kind: ServiceCategoryKind.LEAF,
    // Open to applications from the day it lands: this wave exists to be
    // staffed before it is released, and a draft nobody may apply to
    // collects nobody. Groups and routers stay closed — neither is work.
    providerEnrollmentOpen: true,
    status: ServiceCategoryStatus.DRAFT,
    parentSlug: 'kurumsal-ve-danismanlik',
    sortOrder: 183,
    iconKey: 'box',
    questions: [
      {
        key: 'sirket_tipi',
        label: 'Hangi tip şirket kurmak istiyorsunuz?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 10,
        options: [
          option('sahis', 'Şahıs işletmesi'),
          option('limited', 'Limited şirket'),
          option('anonim', 'Anonim şirket'),
          option('kararsizim', 'Kararsızım, öneri istiyorum'),
        ],
      },
      {
        key: 'ortak_sayisi',
        label: 'Kaç ortak olacak?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 20,
        options: [
          option('ortak_1', 'Tek ortak'),
          option('ortak_2', '2 ortak'),
          option('ortak_3_5', '3–5 ortak'),
          option('ortak_5_ustu', '5 ortaktan fazla'),
        ],
      },
      {
        key: 'hizmet_kapsami',
        label: 'Hangi konularda destek istiyorsunuz?',
        helpText: 'Birden fazla seçebilirsiniz.',
        type: ServiceRequestQuestionType.MULTI_SELECT,
        isRequired: true,
        sortOrder: 30,
        options: [
          option('kurulus_islemleri', 'Kuruluş işlemleri'),
          option('vergi_dairesi', 'Vergi dairesi işlemleri'),
          option('ana_sozlesme', 'Ana sözleşme hazırlığı'),
          option('adres_ofis', 'Adres veya sanal ofis'),
          option('tesvik', 'Teşvik ve destek başvuruları'),
          option('kurulus_sonrasi', 'Kuruluş sonrası muhasebe'),
        ],
      },
      {
        key: 'zaman_plani',
        label: 'Kuruluşu ne zaman tamamlamak istiyorsunuz?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 40,
        options: [
          option('bu_hafta', 'Bu hafta'),
          option('bu_ay', 'Bu ay'),
          option('uc_ay_icinde', '3 ay içinde'),
          option('plan_belirsiz', 'Henüz belirsiz'),
        ],
      },
      jobDescription(50, 'Kurmak istediğiniz işi kısaca anlatın'),
    ],
  },
  {
    slug: 'isg-danismanligi',
    name: 'İSG Danışmanlığı',
    description: 'İş sağlığı ve güvenliği süreçlerinin kurulması ve yürütülmesi.',
    kind: ServiceCategoryKind.LEAF,
    // Open to applications from the day it lands: this wave exists to be
    // staffed before it is released, and a draft nobody may apply to
    // collects nobody. Groups and routers stay closed — neither is work.
    providerEnrollmentOpen: true,
    status: ServiceCategoryStatus.DRAFT,
    parentSlug: 'kurumsal-ve-danismanlik',
    sortOrder: 184,
    iconKey: 'box',
    questions: [
      {
        key: 'tehlike_sinifi',
        label: 'İşyerinizin tehlike sınıfı nedir?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 10,
        options: [
          option('az_tehlikeli', 'Az tehlikeli'),
          option('tehlikeli', 'Tehlikeli'),
          option('cok_tehlikeli', 'Çok tehlikeli'),
          option('bilmiyorum', 'Bilmiyorum'),
        ],
      },
      {
        key: 'calisan_sayisi',
        label: 'Kaç çalışanınız var?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 20,
        options: [
          option('calisan_1_9', '1–9 çalışan'),
          option('calisan_10_49', '10–49 çalışan'),
          option('calisan_50_99', '50–99 çalışan'),
          option('calisan_100_249', '100–249 çalışan'),
          option('calisan_250_ustu', '250 çalışan ve üzeri'),
        ],
      },
      {
        key: 'hizmet_kapsami',
        label: 'Hangi hizmetlere ihtiyacınız var?',
        helpText: 'Birden fazla seçebilirsiniz.',
        type: ServiceRequestQuestionType.MULTI_SELECT,
        isRequired: true,
        sortOrder: 30,
        options: [
          option('risk_degerlendirmesi', 'Risk değerlendirmesi'),
          option('acil_durum_plani', 'Acil durum planı'),
          option('is_guvenligi_uzmani', 'İş güvenliği uzmanı'),
          option('isyeri_hekimi', 'İşyeri hekimi'),
          option('egitim', 'Çalışan eğitimleri'),
          option('saha_denetimi', 'Saha denetimi'),
        ],
      },
      {
        key: 'sube_sayisi',
        label: 'Kaç ayrı işyeri veya şube var?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 40,
        options: [
          option('sube_1', '1'),
          option('sube_2_3', '2–3'),
          option('sube_4_10', '4–10'),
          option('sube_10_ustu', '10 ve üzeri'),
        ],
      },
      {
        key: 'mevcut_hizmet',
        label: 'Şu anda İSG hizmeti alıyor musunuz?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 50,
        options: [
          option('aliyorum', 'Alıyorum, değiştirmek istiyorum'),
          option('almiyorum', 'Daha önce aldım, şu an almıyorum'),
          option('ilk_kez', 'İlk kez alacağım'),
        ],
      },
      jobDescription(60, 'İşyerinizi ve faaliyet alanınızı kısaca anlatın'),
    ],
  },
];

const digital: CategoryDefinition[] = [
  {
    slug: 'arama-motoru-optimizasyonu',
    name: 'Arama Motoru Optimizasyonu',
    description: 'Web sitesinin arama sonuçlarındaki görünürlüğünü artırma çalışması.',
    kind: ServiceCategoryKind.LEAF,
    // Open to applications from the day it lands: this wave exists to be
    // staffed before it is released, and a draft nobody may apply to
    // collects nobody. Groups and routers stay closed — neither is work.
    providerEnrollmentOpen: true,
    status: ServiceCategoryStatus.DRAFT,
    parentSlug: 'dijital-ve-yaratici',
    sortOrder: 191,
    iconKey: 'bolt',
    questions: [
      {
        key: 'site_durumu',
        label: 'Web siteniz hangi durumda?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 10,
        options: [
          option('yayinda', 'Yayında'),
          option('yenileniyor', 'Yenileniyor'),
          option('yok', 'Henüz yok, kurulacak'),
        ],
      },
      {
        key: 'altyapi',
        label: 'Site hangi altyapıda çalışıyor?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 20,
        options: [
          option('hazir_cms', 'Hazır içerik yönetim sistemi'),
          option('hazir_eticaret', 'Hazır e-ticaret paketi'),
          option('ozel_yazilim', 'Özel yazılım'),
          option('bilmiyorum', 'Bilmiyorum'),
        ],
      },
      {
        key: 'hizmet_kapsami',
        label: 'Hangi çalışmaları istiyorsunuz?',
        helpText: 'Birden fazla seçebilirsiniz.',
        type: ServiceRequestQuestionType.MULTI_SELECT,
        isRequired: true,
        sortOrder: 30,
        options: [
          option('teknik_seo', 'Teknik iyileştirme'),
          option('anahtar_kelime', 'Anahtar kelime çalışması'),
          option('icerik', 'İçerik üretimi'),
          option('baglanti', 'Dış bağlantı çalışması'),
          option('yerel', 'Yerel arama görünürlüğü'),
          option('raporlama', 'Dönemsel raporlama'),
        ],
      },
      {
        key: 'hedef_bolge',
        label: 'Hedef kitleniz nerede?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 40,
        options: [
          option('tek_sehir', 'Tek şehir'),
          option('turkiye', 'Türkiye geneli'),
          option('yurt_disi', 'Yurt dışı'),
          option('karma', 'Karma'),
        ],
      },
      {
        key: 'calisma_suresi',
        label: 'Ne kadar süreli bir çalışma planlıyorsunuz?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 50,
        options: [
          option('tek_seferlik', 'Tek seferlik analiz'),
          option('ay_3', '3 ay'),
          option('ay_6', '6 ay'),
          option('ay_12_ustu', '12 ay ve üzeri'),
          option('kararsizim', 'Kararsızım'),
        ],
      },
      jobDescription(60, 'Sitenizi ve hedefinizi kısaca anlatın'),
    ],
  },
  {
    slug: 'sosyal-medya-yonetimi',
    name: 'Sosyal Medya Yönetimi',
    description: 'İçerik planlama, paylaşım ve topluluk yönetimi.',
    kind: ServiceCategoryKind.LEAF,
    // Open to applications from the day it lands: this wave exists to be
    // staffed before it is released, and a draft nobody may apply to
    // collects nobody. Groups and routers stay closed — neither is work.
    providerEnrollmentOpen: true,
    status: ServiceCategoryStatus.DRAFT,
    parentSlug: 'dijital-ve-yaratici',
    sortOrder: 192,
    iconKey: 'bolt',
    questions: [
      {
        key: 'platformlar',
        label: 'Hangi platformlar yönetilsin?',
        helpText: 'Birden fazla seçebilirsiniz.',
        type: ServiceRequestQuestionType.MULTI_SELECT,
        isRequired: true,
        sortOrder: 10,
        options: [
          option('gorsel_paylasim', 'Görsel paylaşım ağları'),
          option('kisa_video', 'Kısa video platformları'),
          option('profesyonel_ag', 'Profesyonel ağlar'),
          option('video_kanali', 'Video kanalı'),
          option('diger', 'Diğer'),
        ],
      },
      {
        key: 'hesap_durumu',
        label: 'Hesaplarınız hangi durumda?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 20,
        options: [
          option('aktif', 'Aktif, düzenli paylaşım var'),
          option('durgun', 'Açık ama uzun süredir paylaşım yok'),
          option('sifirdan', 'Sıfırdan açılacak'),
        ],
      },
      {
        key: 'hizmet_kapsami',
        label: 'Hangi işler dahil olsun?',
        helpText: 'Birden fazla seçebilirsiniz.',
        type: ServiceRequestQuestionType.MULTI_SELECT,
        isRequired: true,
        sortOrder: 30,
        options: [
          option('icerik_uretimi', 'İçerik üretimi'),
          option('tasarim', 'Görsel tasarım'),
          option('video_kurgu', 'Video kurgu'),
          option('planlama', 'Paylaşım planlama'),
          option('reklam', 'Reklam yönetimi'),
          option('topluluk', 'Yorum ve mesaj yönetimi'),
          option('raporlama', 'Dönemsel raporlama'),
        ],
      },
      {
        key: 'paylasim_sikligi',
        label: 'Ayda kaç paylaşım planlıyorsunuz?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 40,
        options: [
          option('paylasim_8_alti', '8 paylaşımdan az'),
          option('paylasim_8_12', '8–12 paylaşım'),
          option('paylasim_12_20', '12–20 paylaşım'),
          option('paylasim_20_ustu', '20 paylaşımdan fazla'),
          option('kararsizim', 'Kararsızım'),
        ],
      },
      {
        key: 'cekim_ihtiyaci',
        label: 'Yerinde çekim gerekiyor mu?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 50,
        options: [
          option('duzenli', 'Evet, düzenli olarak'),
          option('ara_ara', 'Evet, ara ara'),
          option('hayir', 'Hayır'),
          option('kararsizim', 'Kararsızım'),
        ],
      },
      jobDescription(60, 'Markanızı ve hedefinizi kısaca anlatın'),
    ],
  },
  {
    slug: 'mobil-uygulama-gelistirme',
    name: 'Mobil Uygulama Geliştirme',
    description: 'Mobil uygulamanın sıfırdan geliştirilmesi veya mevcut uygulamanın büyütülmesi.',
    kind: ServiceCategoryKind.LEAF,
    // Open to applications from the day it lands: this wave exists to be
    // staffed before it is released, and a draft nobody may apply to
    // collects nobody. Groups and routers stay closed — neither is work.
    providerEnrollmentOpen: true,
    status: ServiceCategoryStatus.DRAFT,
    parentSlug: 'dijital-ve-yaratici',
    sortOrder: 193,
    iconKey: 'bolt',
    questions: [
      {
        key: 'proje_durumu',
        label: 'Proje hangi aşamada?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 10,
        options: [
          option('sifirdan', 'Sıfırdan yeni uygulama'),
          option('mevcut_gelistirme', 'Yayındaki uygulama geliştirilecek'),
          option('mevcut_bakim', 'Yayındaki uygulamaya bakım'),
        ],
      },
      {
        key: 'mevcut_uygulama_notu',
        label: 'Mevcut uygulamanın adı veya mağaza bağlantısı',
        type: ServiceRequestQuestionType.TEXT,
        isRequired: true,
        sortOrder: 20,
        conditions: [
          {
            sourceQuestionKey: 'proje_durumu',
            expectedValues: ['mevcut_gelistirme', 'mevcut_bakim'],
          },
        ],
      },
      {
        key: 'platformlar',
        label: 'Hangi platformlar hedefleniyor?',
        helpText: 'Birden fazla seçebilirsiniz.',
        type: ServiceRequestQuestionType.MULTI_SELECT,
        isRequired: true,
        sortOrder: 30,
        options: [
          option('ios', 'iOS'),
          option('android', 'Android'),
          option('web_panel', 'Web yönetim paneli'),
        ],
      },
      {
        key: 'ozellikler',
        label: 'Uygulamada hangi özellikler olacak?',
        helpText: 'Birden fazla seçebilirsiniz.',
        type: ServiceRequestQuestionType.MULTI_SELECT,
        isRequired: true,
        sortOrder: 40,
        options: [
          option('uyelik', 'Üyelik ve giriş'),
          option('odeme', 'Ödeme'),
          option('harita', 'Harita ve konum'),
          option('bildirim', 'Anlık bildirim'),
          option('mesajlasma', 'Mesajlaşma'),
          option('yonetim_paneli', 'Yönetim paneli'),
          option('kararsizim', 'Kararsızım, öneri istiyorum'),
        ],
      },
      {
        key: 'tasarim_durumu',
        label: 'Arayüz tasarımı hazır mı?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 50,
        options: [
          option('hazir', 'Tasarım dosyaları hazır'),
          option('taslak', 'Fikir var, tasarım yok'),
          option('tasarim_da_istiyorum', 'Tasarımı da hizmet veren yapsın'),
        ],
      },
      projectBudget(
        60,
        'Bu proje için ayırdığınız bütçe aralığı',
        'Yaklaşık bir aralık vermeniz, size uygun kapsamda teklif gelmesini sağlar.',
      ),
      jobDescription(70, 'Uygulamanın ne yapmasını istediğinizi kısaca anlatın'),
    ],
  },
  {
    slug: 'urun-fotograf-cekimi',
    name: 'Ürün Fotoğraf Çekimi',
    description: 'Satış ve katalog için ürün fotoğrafı çekimi ve retuşu.',
    kind: ServiceCategoryKind.LEAF,
    // Open to applications from the day it lands: this wave exists to be
    // staffed before it is released, and a draft nobody may apply to
    // collects nobody. Groups and routers stay closed — neither is work.
    providerEnrollmentOpen: true,
    status: ServiceCategoryStatus.DRAFT,
    parentSlug: 'dijital-ve-yaratici',
    sortOrder: 194,
    iconKey: 'bolt',
    questions: [
      {
        key: 'urun_adedi',
        label: 'Kaç ürün çekilecek?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 10,
        options: [
          option('adet_10_alti', '10 üründen az'),
          option('adet_10_30', '10–30 ürün'),
          option('adet_30_75', '30–75 ürün'),
          option('adet_75_150', '75–150 ürün'),
          option('adet_150_ustu', '150 üründen fazla'),
        ],
      },
      {
        key: 'cekim_tipi',
        label: 'Nasıl bir çekim gerekiyor?',
        helpText: 'Birden fazla seçebilirsiniz.',
        type: ServiceRequestQuestionType.MULTI_SELECT,
        isRequired: true,
        sortOrder: 20,
        options: [
          option('beyaz_fon', 'Beyaz fon'),
          option('konsept', 'Konsept çekim'),
          option('manken', 'Manken ile giyim çekimi'),
          option('detay', 'Detay ve makro çekim'),
          option('video', 'Ürün videosu'),
        ],
      },
      {
        key: 'cekim_yeri',
        label: 'Çekim nerede yapılsın?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 30,
        options: [
          option('studyo', 'Hizmet verenin stüdyosunda'),
          option('bizim_adresimiz', 'Bizim adresimizde'),
          option('farketmez', 'Farketmez'),
        ],
      },
      {
        key: 'kullanim_amaci',
        label: 'Görseller nerede kullanılacak?',
        helpText: 'Birden fazla seçebilirsiniz.',
        type: ServiceRequestQuestionType.MULTI_SELECT,
        isRequired: true,
        sortOrder: 40,
        options: [
          option('pazaryeri', 'Pazaryeri ilanları'),
          option('web_sitesi', 'Kendi web sitemiz'),
          option('sosyal_medya', 'Sosyal medya'),
          option('katalog', 'Basılı katalog'),
          option('reklam', 'Reklam görselleri'),
        ],
      },
      {
        key: 'retus',
        label: 'Retuş dahil olsun mu?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 50,
        options: [
          option('tam_retus', 'Evet, tam retuş'),
          option('temel_retus', 'Evet, temel düzeltme'),
          option('hayir', 'Hayır'),
        ],
      },
      jobDescription(60, 'Ürünlerinizi ve beklediğiniz görsel dilini kısaca anlatın'),
    ],
  },
];

export const WAVE_2: CategoryWave = {
  name: 'wave-2-draft',
  // Yeni gruplar önce: bir hizmet üst kategorisini slug ile adlandırır ve içe
  // aktarıcı kategorileri göründükleri sırada oluşturur. Dalga 1'in grupları
  // burada yeniden tanımlanmaz; içe aktarıcı onları veritabanından bulur.
  categories: [...groups, ...renovation, ...installation, ...education, ...events, ...wellness, ...business, ...digital],
};
