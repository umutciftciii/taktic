import {
  PURCHASE_TERMS_DOCUMENT_SET_KEY,
  type PurchaseTermsDocumentSet,
} from './purchase-terms.documents';

/**
 * The purchase-terms document set of `PURCHASE_TERMS_GATE=test` (CMP-006
 * PR-B.1).
 *
 * ## Not a contract, anywhere
 *
 * This set exists so the credit-package checkout and the package refund flow
 * can be exercised end to end — consent box, acceptance evidence, refund
 * request — on a local stack, in the test suite and on staging, without
 * pretending that the draft of the real documents is a contract. Every
 * document opens with {@link PURCHASE_TERMS_TEST_NOTICE}; the gate refuses a
 * TEST set that lacks it, refuses to serve a TEST set with `on`, and refuses
 * `test` itself on production (purchase-terms.config.ts).
 *
 * An acceptance recorded under this set is real evidence of what the tester
 * was shown — snapshot, digest, time, address, user agent, channel — exactly
 * as the real flow records it. Its version (`test-…`) and its text say it was
 * a test.
 *
 * ## Changing any text here
 *
 * The same rule as the production set: a changed title or text changes the
 * snapshot's SHA-256, so the declared `sha256` and the `version` change with
 * it, or the gate refuses to open (and purchase-terms-gate.spec.ts fails).
 */

/** The sentence every TEST document starts with, and the marker the gate checks. */
export const PURCHASE_TERMS_TEST_NOTICE =
  'TEST ORTAMI — ÜRETİM SÖZLEŞMESİ DEĞİLDİR. Bu metin yalnız yerel, test ve staging ortamlarında ' +
  'satın alma ve paket iadesi akışlarını denemek için gösterilir. Hukuki bir sözleşme değildir; ' +
  'burada verilen onay yalnız test kaydı olarak saklanır.';

export const PURCHASE_TERMS_TEST_DOCUMENT_SET: PurchaseTermsDocumentSet = {
  documentKey: PURCHASE_TERMS_DOCUMENT_SET_KEY,
  purpose: 'TEST',
  version: 'test-2026-09-24.1',
  legalReview: { status: 'PENDING' },
  sha256: '06a038e8c66fceeb46f61157f7c0fcee0b0ab03234f43983353996e960b4984d',
  documents: [
    {
      key: 'MESAFELI_SATIS_SOZLESMESI',
      title: 'Mesafeli Satış Sözleşmesi (Test)',
      text: [
        PURCHASE_TERMS_TEST_NOTICE,
        '',
        'Test kapsamı: Bu belge, kredi paketi satın alma ekranında sözleşme kabul kutusunun, ' +
          'kabul kanıtının (metin, özet, zaman, istemci adresi, tarayıcı bilgisi, kanal) ve ' +
          'ödeme sonrası akışların denenmesi için yazılmış bir yer tutucudur.',
        '',
        'Taraflar ve konu: Test ortamındaki TakTic platformu ile test hesabı sahibi hizmet ' +
          'sağlayıcı. Satın alınan şey, test ortamında teklif göndermek için kullanılan kredi ' +
          'paketidir. Test ortamında gerçek bir ödeme alınmaz.',
        '',
        'İade: Kredi paketlerinin iadesi, bu test belge setinin parçası olan Kredi Paketi İade ' +
          'Politikası (Test) ile aynı kurallarla denenir.',
      ].join('\n'),
    },
    {
      key: 'ON_BILGILENDIRME_FORMU',
      title: 'Ön Bilgilendirme Formu (Test)',
      text: [
        PURCHASE_TERMS_TEST_NOTICE,
        '',
        'Ürün: Test ortamında teklif kredisi paketi. Paketin adı, kredi miktarı ve fiyatı satın ' +
          'alma anında paket kartında gösterilir ve satın alma kaydına aynen işlenir.',
        '',
        'Ödeme: Test ortamında ödeme, sahte (mock) ödeme ekranı ya da ödeme sağlayıcısının test ' +
          'modu ile yapılır; gerçek kart çekimi yapılmaz. Krediler ödeme doğrulandıktan sonra ' +
          'hesaba tanımlanır.',
        '',
        'Bu formdaki satıcı bilgileri, cayma hakkı ve şikâyet yolları üretim metninde yer alır; ' +
          'test metni bunların yerine geçmez.',
      ].join('\n'),
    },
    {
      key: 'PAKET_IADE_POLITIKASI',
      title: 'Kredi Paketi İade Politikası (Test)',
      text: [
        PURCHASE_TERMS_TEST_NOTICE,
        '',
        'Süre: Kredi paketinin iadesi, ödemenin doğrulandığı andan itibaren on dört (14) gün ' +
          'içinde talep edilebilir.',
        '',
        'Kredi kullanımı: Ödemenin doğrulandığı andan sonra hesapta herhangi bir teklif kredisi ' +
          'kullanılmışsa iade yapılmaz.',
        '',
        'Promosyon kredileri: Satın almaya bağlı promosyon kredilerinden tek bir kredinin dahi ' +
          'kullanılmış olması hâlinde iade yapılmaz.',
        '',
        'İade talebi: Talepler destek kanalı üzerinden iletilir ve yetkili inceleme sonucunda ' +
          'sonuçlandırılır. Test ortamında gerçek bir para iadesi yapılmaz.',
      ].join('\n'),
    },
  ],
};
