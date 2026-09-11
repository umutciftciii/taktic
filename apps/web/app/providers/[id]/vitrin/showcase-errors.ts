/**
 * The API's refusal codes, in the words a provider reads.
 *
 * A map rather than the API's own message travelling through a query string.
 * The code is the contract and the sentence is prose either side may reword; a
 * URL carrying prose is also a URL carrying whatever the API happened to say,
 * which is not a thing to render back into a page.
 */
export const SHOWCASE_ERROR_MESSAGES: Record<string, string> = {
  SHOWCASE_CARD_NOT_FOUND: 'Vitrin kartı bulunamadı.',
  SHOWCASE_VERSION_NOT_FOUND: 'Vitrin kartı sürümü bulunamadı.',
  SHOWCASE_VERSION_UNDER_REVIEW:
    'Bu kartın bir sürümü incelemede. İnceleme sonuçlanmadan yeni değişiklik kaydedilemez.',
  SHOWCASE_NOTHING_TO_SUBMIT: 'İncelemeye gönderilecek bir taslak sürüm yok.',
  SHOWCASE_PRICE_TERMS_REQUIRED:
    'Kartı incelemeye göndermek için hizmet bedeli sorumluluk metnini onaylamanız gerekir.',
  SHOWCASE_AREA_NOT_COVERED:
    'Seçtiğiniz bölgelerden biri işletme profilinizdeki hizmet bölgelerinin dışında. Önce profilinize ekleyin.',
  SHOWCASE_AREA_UNKNOWN: 'Seçilen il, ilçe ve mahalle birlikte geçerli bir bölge oluşturmuyor.',
  SHOWCASE_AREA_DUPLICATE: 'Aynı bölgeyi listeye birden fazla kez eklediniz.',
  SHOWCASE_AREA_OVERLAP:
    'Seçtiğiniz bölgelerden biri diğerini zaten kapsıyor. Geniş olanı ya da dar olanı kaldırın.',
  SHOWCASE_CATEGORY_NOT_OFFERED:
    'Bu kategoride vitrin kartı açamazsınız. Kart yalnız işletme profilinizde seçili olan hizmet kategorilerinde açılabilir.',
  SHOWCASE_CONTENT_INVALID:
    'Kart bilgileri kabul edilmedi. Tür, fiyat, kapsam ve yanıt sürelerini kontrol edin.',
  SHOWCASE_NOTHING_TO_WITHDRAW: 'Geri çekilecek, incelemede bekleyen bir sürüm yok.',
  SHOWCASE_CARD_LOCKED: 'Bu kart şu anda düzenlenemez.',
  SHOWCASE_SAVE_FAILED: 'Kaydedilemedi. Alanları kontrol edip tekrar deneyin.',

  // Phase two: buying a run, and what can be in the way.
  SHOWCASE_PACKAGE_NOT_FOUND: 'Seçtiğiniz vitrin paketi artık satışta değil.',
  SHOWCASE_PACKAGE_KIND_MISMATCH:
    'Bu paket bu kart tipi için satılmıyor. Kart tipine uygun bir paket seçin.',
  SHOWCASE_CARD_NOT_PUBLISHABLE:
    'Bu kart yayına alınamaz. Paket almak için kartın onaylanmış ve yayında bir sürümü olmalı.',
  SHOWCASE_CARD_ALREADY_PLACED:
    'Bu kartın yayında olan bir vitrin süresi zaten var. Süre bitince yenileyebilir ya da başka bir kartınız için paket alabilirsiniz.',
  SHOWCASE_PROVIDER_NOT_APPROVED:
    'Vitrin paketi almak için işletme başvurunuzun onaylanmış olması gerekir.',
  SHOWCASE_CATEGORY_NOT_OFFERED_FOR_PLACEMENT:
    'Kartın kategorisi artık talep alamıyor, bu yüzden yayına alınamaz.',
  SHOWCASE_CARD_ALREADY_ARCHIVED: 'Bu kart zaten arşivlenmiş.',
  // Not a fault and not a block on anything already running: the platform's
  // price-responsibility text has moved on and the next purchase is sold under
  // the new one. The sentence says so explicitly, because "onay gerekiyor" on a
  // screen that also shows a live run reads like the run is at risk.
  SHOWCASE_PRICE_TERMS_REACCEPT_REQUIRED:
    'Hizmet bedeli sorumluluk metni güncellendi. Yeni paket almadan önce güncel metni onaylayın. Yayında olan vitrin süreniz bundan etkilenmez.',
  SHOWCASE_PRICE_TERMS_UNAVAILABLE:
    'Vitrin paketi satın alma şu anda geçici olarak kapalı. Lütfen daha sonra tekrar deneyin.',
  SHOWCASE_CHECKOUT_FAILED: 'Ödeme sayfası açılamadı. Lütfen birkaç dakika içinde tekrar deneyin.',
  PROVIDER_UNAVAILABLE: 'Ödeme sayfası şu anda açılamadı. Lütfen birkaç dakika içinde tekrar deneyin.',
  /*
   * The package exists in the catalogue but has no variant mapped at the
   * payment provider yet.
   *
   * A configuration gap rather than anything the provider did, so the sentence
   * says what they can do — come back — instead of naming the payment provider,
   * the mapping, or the support queue. The machine-readable code is unchanged
   * and still reaches the log, which is where the operator's half of this
   * lives.
   */
  PACKAGE_NOT_MAPPED:
    'Bu paket şu anda satın almaya açılmadı. Lütfen daha sonra tekrar deneyin.',
};
