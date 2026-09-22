/**
 * The purchase-terms document set a provider accepts at a credit-package
 * checkout (CMP-006 PR-A).
 *
 * ## This is a DRAFT and says so
 *
 * `legalReview.status` is `PENDING`. Nothing in this file has been reviewed by
 * a lawyer, and engineering does not write the legal text: the refund-policy
 * clauses below are the product rules of CMP-006 D1 in plain words, and the
 * two legal documents are placeholders that name what is missing (RG-1).
 *
 * The release gate refuses to open on staging or production with a document
 * set that is not `APPROVED` (purchase-terms.config.ts), so this text can be
 * shown only on a local stack or in a test process — and there it is shown
 * under a "TASLAK" banner, never as an approved contract.
 *
 * ## Changing any text here
 *
 * Any change to a title or a text changes the combined snapshot and therefore
 * its SHA-256. The declared `sha256` below must then be updated together with
 * a new `version`; a mismatch is a corrupt document set and the gate stays
 * shut (the process refuses to boot with the gate on, and the unit test in
 * purchase-terms.spec.ts fails). Old acceptances keep the text they were shown
 * — the snapshot on the acceptance row is never rewritten.
 */

export type PurchaseTermsDocumentKey =
  | 'MESAFELI_SATIS_SOZLESMESI'
  | 'ON_BILGILENDIRME_FORMU'
  | 'PAKET_IADE_POLITIKASI';

/** The three documents, in the order the snapshot carries them. */
export const PURCHASE_TERMS_DOCUMENT_KEYS: readonly PurchaseTermsDocumentKey[] = [
  'MESAFELI_SATIS_SOZLESMESI',
  'ON_BILGILENDIRME_FORMU',
  'PAKET_IADE_POLITIKASI',
];

export const PURCHASE_TERMS_DOCUMENT_SET_KEY = 'PACKAGE_PURCHASE_TERMS';

export type PurchaseTermsLegalReview =
  | { status: 'PENDING' }
  | { status: 'APPROVED'; approvedAt: string; reference: string };

export type PurchaseTermsDocument = {
  key: PurchaseTermsDocumentKey;
  title: string;
  text: string;
};

export type PurchaseTermsDocumentSet = {
  documentKey: string;
  version: string;
  legalReview: PurchaseTermsLegalReview;
  /** SHA-256 (hex) of the combined snapshot built by purchase-terms.snapshot.ts. */
  sha256: string;
  documents: readonly PurchaseTermsDocument[];
};

const DRAFT_NOTICE =
  'TASLAK — HUKUK ONAYI BEKLİYOR. Bu metin avukat tarafından onaylanmamıştır ve onaylanmış bir ' +
  'sözleşme değildir. Yalnız yerel ve test ortamlarında, satın alma sözleşme kanıtı altyapısını ' +
  'denemek için gösterilir.';

export const PURCHASE_TERMS_DOCUMENT_SET: PurchaseTermsDocumentSet = {
  documentKey: PURCHASE_TERMS_DOCUMENT_SET_KEY,
  version: '2026-09-22.taslak-1',
  legalReview: { status: 'PENDING' },
  sha256: 'b0a419dabf432ad719341c213ffd278a06c4604e28cded0a470d15527d4f1877',
  documents: [
    {
      key: 'MESAFELI_SATIS_SOZLESMESI',
      title: 'Mesafeli Satış Sözleşmesi',
      text: [
        DRAFT_NOTICE,
        '',
        'Taraflar: TakTic hizmet platformu (satıcı) ve kredi paketini satın alan hizmet sağlayıcı ' +
          '(alıcı). Satıcının unvanı, adresi, iletişim ve sicil bilgileri hukuk onayından sonra bu ' +
          'bölüme eklenecektir. [RG-1: hukuk metni bekleniyor]',
        '',
        'Konu: Alıcının TakTic üzerinde teklif göndermek için kullandığı teklif kredilerinden oluşan ' +
          'paketin elektronik ortamda satışı. Paketin adı, kredi miktarı, fiyatı ve para birimi ' +
          'satın alma anında sipariş özetinde gösterilir ve satın alma kaydına aynen işlenir.',
        '',
        'Ödeme ve ifa: Ödeme, ödeme hizmet sağlayıcısının güvenli ödeme sayfasında yapılır. Krediler, ' +
          'ödeme, ödeme hizmet sağlayıcısı tarafından doğrulandıktan sonra hesaba tanımlanır.',
        '',
        'Cayma hakkı ve anında ifa: Kredilerin hesaba anında tanımlanmasının cayma hakkına etkisi ' +
          'hukuk değerlendirmesi sonucunda bu bölüme yazılacaktır. [RG-1: hukuk metni bekleniyor]',
        '',
        'İade: Kredi paketlerinin iadesi, bu belge setinin parçası olan Kredi Paketi İade ' +
          'Politikası ile düzenlenir.',
      ].join('\n'),
    },
    {
      key: 'ON_BILGILENDIRME_FORMU',
      title: 'Ön Bilgilendirme Formu',
      text: [
        DRAFT_NOTICE,
        '',
        'Satıcı bilgileri: TakTic hizmet platformunun unvanı, adresi, telefon ve e-posta iletişim ' +
          'bilgileri hukuk onayından sonra bu bölüme eklenecektir. [RG-1: hukuk metni bekleniyor]',
        '',
        'Ürünün temel nitelikleri: Teklif kredisi paketi; TakTic üzerindeki hizmet taleplerine ' +
          'teklif göndermek için kullanılan, süresiz kredilerden oluşur. Her talebin kredi bedeli o ' +
          'talebin detay ekranında yazılıdır.',
        '',
        'Toplam fiyat: Paketin vergiler dahil toplam fiyatı ve para birimi, ödeme sayfasına ' +
          'geçmeden önce paket kartında gösterilir.',
        '',
        'Ödeme ve teslim: Ödeme, ödeme hizmet sağlayıcısının sayfasında yapılır; krediler ödemenin ' +
          'doğrulanmasının ardından hesaba tanımlanır.',
        '',
        'Cayma hakkı: Cayma hakkının kullanılıp kullanılamayacağı ve koşulları hukuk ' +
          'değerlendirmesinden sonra yazılacaktır. [RG-1: hukuk metni bekleniyor]',
        '',
        'Şikâyet ve itiraz: Başvuru yolları hukuk onayından sonra eklenecektir.',
      ].join('\n'),
    },
    {
      key: 'PAKET_IADE_POLITIKASI',
      title: 'Kredi Paketi İade Politikası',
      text: [
        DRAFT_NOTICE,
        '',
        'Süre: Kredi paketinin iadesi, ödemenin doğrulandığı andan itibaren on dört (14) gün ' +
          'içinde talep edilebilir.',
        '',
        'Kredi kullanımı: Ödemenin doğrulandığı andan sonra hesapta herhangi bir teklif kredisi ' +
          'kullanılmışsa iade yapılmaz. Bu kural, kullanılan kredinin satın alınan paketten, bir ' +
          'promosyondan veya önceki bakiyeden gelmiş olmasına bakılmaksızın uygulanır.',
        '',
        'Promosyon kredileri: Satın almaya bağlı promosyon kredilerinden tek bir kredinin dahi ' +
          'kullanılmış olması hâlinde iade yapılmaz. Kullanılmamış paketin iadesinde, o paketle ' +
          'birlikte verilmiş kullanılmamış promosyon kredileri iptal edilir.',
        '',
        'İstisnalar: Zorunlu kanuni haklar, doğrulanmış yetkisiz işlem, çift tahsilat ve TakTic ' +
          'kaynaklı hizmet kusuru hâlleri yukarıdaki sınırlamalardan istisnadır. Bu hâllerde iade, ' +
          'otomatik olarak değil, TakTic yetkililerinin incelemesi sonucunda yapılır.',
        '',
        'İade talebi: İade, platform içinden otomatik olarak yapılmaz; talepler destek kanalı ' +
          'üzerinden iletilir ve yetkili inceleme sonucunda sonuçlandırılır.',
      ].join('\n'),
    },
  ],
};
