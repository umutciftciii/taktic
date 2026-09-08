import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';

/**
 * Every refusal this feature can produce, as a closed set of machine codes and
 * the Turkish sentence that goes with each.
 *
 * Codes rather than string matching, for the reason the offer flow already uses
 * them: the web application maps a refusal onto a screen, and matching on
 * message text makes a copy edit a functional change.
 */

export const SHOWCASE_CARD_NOT_FOUND_CODE = 'SHOWCASE_CARD_NOT_FOUND';
export const SHOWCASE_VERSION_NOT_FOUND_CODE = 'SHOWCASE_VERSION_NOT_FOUND';
export const SHOWCASE_VERSION_UNDER_REVIEW_CODE = 'SHOWCASE_VERSION_UNDER_REVIEW';
export const SHOWCASE_VERSION_NOT_PENDING_CODE = 'SHOWCASE_VERSION_NOT_PENDING';
export const SHOWCASE_NOTHING_TO_SUBMIT_CODE = 'SHOWCASE_NOTHING_TO_SUBMIT';
export const SHOWCASE_PRICE_TERMS_REQUIRED_CODE = 'SHOWCASE_PRICE_TERMS_REQUIRED';
export const SHOWCASE_AREA_NOT_COVERED_CODE = 'SHOWCASE_AREA_NOT_COVERED';
export const SHOWCASE_AREA_UNKNOWN_CODE = 'SHOWCASE_AREA_UNKNOWN';
export const SHOWCASE_AREA_DUPLICATE_CODE = 'SHOWCASE_AREA_DUPLICATE';
export const SHOWCASE_AREA_OVERLAP_CODE = 'SHOWCASE_AREA_OVERLAP';
export const SHOWCASE_CATEGORY_NOT_OFFERED_CODE = 'SHOWCASE_CATEGORY_NOT_OFFERED';
export const SHOWCASE_CONTENT_INVALID_CODE = 'SHOWCASE_CONTENT_INVALID';
export const SHOWCASE_CARD_LOCKED_CODE = 'SHOWCASE_CARD_LOCKED';
export const SHOWCASE_NOTHING_TO_WITHDRAW_CODE = 'SHOWCASE_NOTHING_TO_WITHDRAW';

/**
 * A card the caller may not read, and a card that does not exist, answer
 * identically.
 *
 * 404 rather than 403, exactly as `getProviderForViewer` already decides for a
 * provider profile: telling one provider that another provider's card id is
 * real lets them walk the id space and learn who is advertising what, at what
 * price, before any of it is public. An unreachable card must be
 * indistinguishable from a non-existent one.
 */
export function showcaseCardNotFound() {
  return new NotFoundException({
    statusCode: HttpStatus.NOT_FOUND,
    error: 'Not Found',
    code: SHOWCASE_CARD_NOT_FOUND_CODE,
    message: 'Vitrin kartı bulunamadı.',
  });
}

/** The same rule for a version addressed directly. */
export function showcaseVersionNotFound() {
  return new NotFoundException({
    statusCode: HttpStatus.NOT_FOUND,
    error: 'Not Found',
    code: SHOWCASE_VERSION_NOT_FOUND_CODE,
    message: 'Vitrin kartı sürümü bulunamadı.',
  });
}

/**
 * The provider tried to edit a version an operator is holding.
 *
 * A version does not change after it is submitted. That is what makes the review
 * row mean something: `ShowcaseCardReview.cardVersionId` names the exact text
 * somebody read, and a version that could be edited underneath a reviewer would
 * turn every approval into an approval of something else.
 */
export function showcaseVersionUnderReview() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_VERSION_UNDER_REVIEW_CODE,
    message:
      'Bu kartın bir sürümü incelemede. İnceleme sonuçlanmadan yeni değişiklik kaydedilemez.',
  });
}

/**
 * An operator acted on a version that is not waiting for one.
 *
 * Undifferentiated on purpose: whether it was already approved, already
 * rejected, still a draft, or decided by another operator a second ago, the
 * answer to this operator is the same — it is not theirs to decide any more.
 */
export function showcaseVersionNotPending() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_VERSION_NOT_PENDING_CODE,
    message: 'Bu sürüm inceleme bekleyen bir sürüm değil.',
  });
}

export function showcaseNothingToSubmit() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_NOTHING_TO_SUBMIT_CODE,
    message: 'İncelemeye gönderilecek bir taslak sürüm yok.',
  });
}

/**
 * Submitted without accepting the price-responsibility text.
 *
 * The database refuses the same thing — a non-DRAFT version with no acceptance
 * on file cannot be stored — so this is the readable half of a rule that holds
 * whether or not this check runs.
 */
export function showcasePriceTermsRequired() {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code: SHOWCASE_PRICE_TERMS_REQUIRED_CODE,
    message:
      'Kartı incelemeye göndermek için hizmet bedeli sorumluluk metnini onaylamanız gerekir.',
  });
}

/**
 * A card area the provider's own service areas do not reach.
 *
 * Named in the message, because "geçersiz bölge" for a list of eight would
 * leave the provider guessing which one. The area is theirs and already on their
 * screen, so naming it discloses nothing.
 */
export function showcaseAreaNotCovered(label: string) {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_AREA_NOT_COVERED_CODE,
    message: `${label} hizmet bölgeleriniz arasında değil. Önce işletme profilinizin hizmet bölgelerine ekleyin.`,
  });
}

export function showcaseAreaUnknown() {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code: SHOWCASE_AREA_UNKNOWN_CODE,
    message: 'Seçilen il, ilçe ve mahalle birlikte geçerli bir bölge oluşturmuyor.',
  });
}

export function showcaseAreaDuplicate(label: string) {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code: SHOWCASE_AREA_DUPLICATE_CODE,
    message: `${label} listede birden fazla kez var.`,
  });
}

/**
 * Two areas on one version where one already reaches everywhere the other does.
 *
 * Both are named, because both are the provider's own choices and neither on
 * its own is the mistake — the pair is. "İstanbul geneli" beside
 * "İstanbul/Kadıköy" is not a wider card, it is the same card written twice,
 * and which of the two to drop is the provider's decision to make.
 */
export function showcaseAreaOverlap(outer: string, inner: string) {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code: SHOWCASE_AREA_OVERLAP_CODE,
    message: `${outer}, ${inner} bölgesini zaten kapsıyor. İkisinden birini kaldırın.`,
  });
}

/**
 * The category is not one this business offers — or is not a category a card
 * may be listed under at all.
 *
 * **One answer for every category refusal, on purpose.** A category that does
 * not exist, one that is still an operator's DRAFT, a router, a group with
 * nothing of this provider's underneath it, and a service they simply have not
 * signed up for all produce this exact body. Telling them apart would answer
 * two questions nobody outside the admin surface may ask: whether a given id
 * names a real category, and what an unreleased catalogue contains.
 *
 * The sentence is written for the case that is nearly always the real one — a
 * provider reaching for a service they have not added to their profile — and
 * points at the screen where they can fix it.
 */
export function showcaseCategoryNotOffered() {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code: SHOWCASE_CATEGORY_NOT_OFFERED_CODE,
    message:
      'Bu kategoride vitrin kartı açamazsınız. Kart yalnız işletme profilinizde seçili olan ' +
      'hizmet kategorilerinde açılabilir.',
  });
}

/**
 * The card's own content does not hold together — a price on a card that makes
 * no price claim, a scope list that emptied out, an urgent promise slower than
 * the ordinary one.
 *
 * Separate from the category refusal above because these are safe to describe:
 * every one of them is about values the caller just sent, so saying which is
 * wrong discloses nothing they did not already have.
 */
export function showcaseContentInvalid(message: string) {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code: SHOWCASE_CONTENT_INVALID_CODE,
    message,
  });
}

/**
 * There is no submission of this card to withdraw.
 *
 * Undifferentiated on purpose, exactly as `showcaseVersionNotPending` is: the
 * card may have no draft at all, its draft may never have been submitted, or an
 * operator may have decided it a second ago. In every case the answer to the
 * provider is the same — there is nothing with the operator right now — and the
 * third case is the one this must not describe, because the decision is the
 * operator's to publish, not this endpoint's to leak early.
 */
export function showcaseNothingToWithdraw() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_NOTHING_TO_WITHDRAW_CODE,
    message: 'Geri çekilecek, incelemede bekleyen bir sürüm yok.',
  });
}

/**
 * The card is suspended or archived.
 *
 * Neither state has a writer in this phase — no endpoint sets them — so nothing
 * can reach this today. It is here because the states exist in the enum, and a
 * service that silently let a suspended card be edited the day somebody adds
 * that action would be a bug written in advance.
 */
export function showcaseCardLocked() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_CARD_LOCKED_CODE,
    message: 'Bu kart şu anda düzenlenemez.',
  });
}
