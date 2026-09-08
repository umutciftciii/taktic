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
export const SHOWCASE_CATEGORY_INVALID_CODE = 'SHOWCASE_CATEGORY_INVALID';
export const SHOWCASE_CARD_LOCKED_CODE = 'SHOWCASE_CARD_LOCKED';

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

export function showcaseCategoryInvalid(message: string) {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code: SHOWCASE_CATEGORY_INVALID_CODE,
    message,
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
