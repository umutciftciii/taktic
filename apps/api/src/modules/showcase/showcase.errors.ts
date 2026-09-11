import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
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

// ────────────────────────────────────────────────────────────────────────────
// Phase two: buying a placement, publishing it, and the direct lead
// ────────────────────────────────────────────────────────────────────────────

export const SHOWCASE_PACKAGE_NOT_FOUND_CODE = 'SHOWCASE_PACKAGE_NOT_FOUND';
export const SHOWCASE_PACKAGE_KIND_MISMATCH_CODE = 'SHOWCASE_PACKAGE_KIND_MISMATCH';
export const SHOWCASE_PACKAGE_SLUG_INVALID_CODE = 'SHOWCASE_PACKAGE_SLUG_INVALID';
export const SHOWCASE_CARD_NOT_PUBLISHABLE_CODE = 'SHOWCASE_CARD_NOT_PUBLISHABLE';
export const SHOWCASE_CARD_ALREADY_PLACED_CODE = 'SHOWCASE_CARD_ALREADY_PLACED';
export const SHOWCASE_PROVIDER_NOT_APPROVED_CODE = 'SHOWCASE_PROVIDER_NOT_APPROVED';
export const SHOWCASE_PLACEMENT_NOT_FOUND_CODE = 'SHOWCASE_PLACEMENT_NOT_FOUND';
export const SHOWCASE_PLACEMENT_NOT_SUSPENDABLE_CODE = 'SHOWCASE_PLACEMENT_NOT_SUSPENDABLE';
export const SHOWCASE_PLACEMENT_NOT_RESUMABLE_CODE = 'SHOWCASE_PLACEMENT_NOT_RESUMABLE';
export const SHOWCASE_PLACEMENT_NOT_CANCELLABLE_CODE = 'SHOWCASE_PLACEMENT_NOT_CANCELLABLE';
export const SHOWCASE_LEAD_AREA_NOT_SERVED_CODE = 'SHOWCASE_LEAD_AREA_NOT_SERVED';
export const SHOWCASE_LEAD_NOT_FOUND_CODE = 'SHOWCASE_LEAD_NOT_FOUND';
export const SHOWCASE_LEAD_PHONE_VERIFICATION_REQUIRED_CODE =
  'SHOWCASE_LEAD_PHONE_VERIFICATION_REQUIRED';
export const SHOWCASE_LEAD_RATE_LIMITED_CODE = 'SHOWCASE_LEAD_RATE_LIMITED';
export const SHOWCASE_FALLBACK_NOT_AVAILABLE_CODE = 'SHOWCASE_FALLBACK_NOT_AVAILABLE';
export const SHOWCASE_FALLBACK_ALREADY_DECIDED_CODE = 'SHOWCASE_FALLBACK_ALREADY_DECIDED';

export function showcasePackageNotFound() {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code: SHOWCASE_PACKAGE_NOT_FOUND_CODE,
    message: 'Etkin bir vitrin paketi bulunamadı.',
  });
}

/**
 * The package does not sell placements for this kind of card.
 *
 * Safe to describe, because both halves are things the caller just chose: their
 * own card and the package they picked next to it.
 */
export function showcasePackageKindMismatch() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_PACKAGE_KIND_MISMATCH_CODE,
    message: 'Bu paket bu kart tipi için satılmıyor. Kart tipine uygun bir paket seçin.',
  });
}

/**
 * The operator tried to create a vitrin package whose slug does not carry the
 * reserved prefix.
 *
 * The prefix is not decoration. `LEMON_SQUEEZY_VARIANT_MAP` is keyed by slug
 * across both catalogues, so a vitrin package sharing a slug namespace with an
 * offer package makes it possible — by configuration alone, with no database
 * constraint able to see it — for one payment variant to stand for two
 * different products. Both CHECK constraints in the database say the same
 * thing; this is the readable half.
 */
export function showcasePackageSlugInvalid() {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code: SHOWCASE_PACKAGE_SLUG_INVALID_CODE,
    message:
      'Vitrin paketinin kısa adı "vitrin-" ile başlamak zorundadır. Bu ön ek, ödeme ' +
      'sağlayıcısındaki ürün eşlemesinin teklif paketleriyle çakışmasını engeller.',
  });
}

/**
 * The card cannot go on the air: it has never been approved, or it has no live
 * version to publish.
 *
 * Distinct from `showcaseCardNotFound` because by the time this fires the
 * caller has already been confirmed as the card's owner — they are looking at
 * it on their own screen — so naming the reason discloses nothing.
 */
export function showcaseCardNotPublishable() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_CARD_NOT_PUBLISHABLE_CODE,
    message:
      'Bu kart yayına alınamaz. Vitrin paketi almak için kartın onaylanmış ve yayında bir ' +
      'sürümü olmalıdır.',
  });
}

/**
 * The card already has a live placement.
 *
 * **Not a limit on how many cards a provider may publish.** A provider may open
 * as many cards as they want and buy a package for every one of them; this
 * refusal is only about paying twice for the same card's single slot, where the
 * second payment would add nothing to what the first one already publishes.
 * That is why the sentence points at the other cards rather than at a cap.
 */
export function showcaseCardAlreadyPlaced() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_CARD_ALREADY_PLACED_CODE,
    message:
      'Bu kartın yayında olan bir vitrin süresi zaten var. Süre bitince yenileyebilir ya da ' +
      'başka bir kartınız için paket alabilirsiniz.',
  });
}

export function showcaseProviderNotApproved() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_PROVIDER_NOT_APPROVED_CODE,
    message: 'Vitrin paketi almak için işletme başvurunuzun onaylanmış olması gerekir.',
  });
}

/** The same 404 discipline as a card: unreachable and non-existent read alike. */
export function showcasePlacementNotFound() {
  return new NotFoundException({
    statusCode: HttpStatus.NOT_FOUND,
    error: 'Not Found',
    code: SHOWCASE_PLACEMENT_NOT_FOUND_CODE,
    message: 'Vitrin yerleşimi bulunamadı.',
  });
}

export function showcasePlacementNotSuspendable() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_PLACEMENT_NOT_SUSPENDABLE_CODE,
    message: 'Yalnız yayında olan bir yerleşim durdurulabilir.',
  });
}

/**
 * Resume refuses anything that is not an operator's own hold.
 *
 * The other five reasons lift by themselves when the condition behind them goes
 * away — a category reopening, a card leaving the archive, an area coming back
 * into coverage, a profile being re-approved. An operator "resuming" one of
 * those would put a card on the air while the thing that took it down is still
 * true.
 */
export function showcasePlacementNotResumable() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_PLACEMENT_NOT_RESUMABLE_CODE,
    message:
      'Bu yerleşim operatör kararıyla durdurulmuş bir yerleşim değil. Diğer durdurma ' +
      'sebepleri, sebep ortadan kalktığında kendiliğinden kalkar.',
  });
}

export function showcasePlacementNotCancellable() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_PLACEMENT_NOT_CANCELLABLE_CODE,
    message: 'Yalnız süresi devam eden bir yerleşim iptal edilebilir.',
  });
}

/**
 * A direct lead was written for an address the card does not serve.
 *
 * **This is the server-side half of the whole vitrin promise, and the client
 * cannot stand in for it.** A visitor may now read every live card from the
 * home page without naming a place, so the card's own "Hizmet bölgesi" line is
 * an *advertisement*, not a gate: it tells somebody what they are looking at.
 * The gate is here. The address on the lead is the address the customer typed
 * into the form, it is re-resolved against the shipped location list, and it is
 * matched against the run's own shelf rows with the identical key rule the shelf
 * was built with — `showcaseCandidateAreaKeys`.
 *
 * The refusal is not a dead end, and the sentence says so: the customer's work
 * is real, it is simply not this business's, and the ordinary marketplace
 * request is one click away. A refusal that only said "no" would push somebody
 * with a genuine job off the platform to protect a rule they never saw.
 *
 * 409 rather than 400: nothing they sent is malformed. The card and the address
 * are each perfectly valid and simply do not belong together.
 */
export function showcaseLeadAreaNotServed() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_LEAD_AREA_NOT_SERVED_CODE,
    message:
      'Bu vitrin hizmeti seçtiğiniz konumu kapsamıyor. Genel talep oluşturmaya devam ' +
      'edebilirsiniz.',
  });
}

export function showcaseLeadNotFound() {
  return new NotFoundException({
    statusCode: HttpStatus.NOT_FOUND,
    error: 'Not Found',
    code: SHOWCASE_LEAD_NOT_FOUND_CODE,
    message: 'Vitrin talebi bulunamadı.',
  });
}

/**
 * A direct lead was opened without a verified telephone number.
 *
 * **Mandatory here whatever REQUIRE_PHONE_VERIFICATION says**, which is the one
 * place in this product where that flag is not the whole answer. Two reasons,
 * and they compound:
 *
 * 1. This message goes straight to a business with no operator between. Every
 *    other route to a provider's inbox passes through moderation; this one
 *    does not, so the one identity check that costs the sender something has to
 *    hold.
 * 2. The request will have to become APPROVED for the provider's own offer to
 *    land, and that transition already refuses an unverified number. Letting
 *    the lead open anyway would start an SLA clock on something that could
 *    never progress — a promise made to somebody it cannot be kept for.
 */
export function showcaseLeadPhoneVerificationRequired() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_LEAD_PHONE_VERIFICATION_REQUIRED_CODE,
    message:
      'Vitrin kartından talep göndermek için telefon numaranızı doğrulamanız gerekir.',
  });
}

/**
 * Too many lead attempts from one telephone number or one address.
 *
 * Deliberately says nothing about which limit was hit or how much of it is
 * left: a rate limit that reports its own state is a rate limit that can be
 * measured and worked around.
 */
export function showcaseLeadRateLimited() {
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      code: SHOWCASE_LEAD_RATE_LIMITED_CODE,
      message: 'Çok fazla talep gönderildi. Lütfen bir süre sonra tekrar deneyin.',
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/**
 * A fallback decision on a lead that is not waiting for one.
 *
 * Undifferentiated on purpose, exactly as `showcaseVersionNotPending` is: the
 * lead may still be inside its window, may have been answered, or may have been
 * decided a moment ago. In every case the answer is the same — there is no
 * decision for this customer to make right now.
 */
export function showcaseFallbackNotAvailable() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_FALLBACK_NOT_AVAILABLE_CODE,
    message: 'Bu talep için şu anda verilecek bir karar yok.',
  });
}

/** The second submission of a decision the customer has already made. */
export function showcaseFallbackAlreadyDecided() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_FALLBACK_ALREADY_DECIDED_CODE,
    message: 'Bu talep için kararınız zaten kaydedildi.',
  });
}

export const SHOWCASE_PRICE_TERMS_REACCEPT_REQUIRED_CODE =
  'SHOWCASE_PRICE_TERMS_REACCEPT_REQUIRED';
export const SHOWCASE_PRICE_TERMS_UNAVAILABLE_CODE = 'SHOWCASE_PRICE_TERMS_UNAVAILABLE';

/**
 * A vitrin checkout was opened without a current acceptance of the
 * price-responsibility text.
 *
 * **This refusal reaches exactly one place: the point of sale.** It is not a
 * hold on anything already bought. A run on the air stays on the air under the
 * terms it was sold under, its card stays approved, and no version is re-opened
 * for review — a bump means the *next* placement is sold on the new sentence,
 * never that an old one is retro-fitted to it.
 *
 * 409 rather than 400, and deliberately: nothing the caller sent is malformed.
 * They asked for something the current state of their own account does not
 * allow yet, and the fix is an action they can take on the screen they are
 * already looking at. The version is named in the body so that screen can offer
 * the right acceptance rather than guessing at one — it is the platform's own
 * public terms version, so naming it discloses nothing.
 */
export function showcasePriceTermsReacceptRequired(requiredVersion: string) {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_PRICE_TERMS_REACCEPT_REQUIRED_CODE,
    requiredVersion,
    message:
      'Hizmet bedeli sorumluluk metni güncellendi. Bu kart için yeni vitrin paketi almadan ' +
      'önce güncel metni onaylamanız gerekir. Yayında olan vitrin süreniz bu onaydan ' +
      'etkilenmez ve kesintisiz devam eder.',
  });
}

/**
 * The platform has no usable price-responsibility text configured.
 *
 * Cannot happen from a well-formed build — the values are constants — which is
 * exactly why the refusal exists: the failure mode it forecloses is silent. A
 * blank version compared against a blank stored version matches, and would sell
 * a placement on terms nobody ever agreed to. 503 rather than 500 because it is
 * a deployment fault rather than a request fault, and the caller has done
 * nothing wrong.
 */
export function showcasePriceTermsUnavailable() {
  return new ServiceUnavailableException({
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    error: 'Service Unavailable',
    code: SHOWCASE_PRICE_TERMS_UNAVAILABLE_CODE,
    message:
      'Hizmet bedeli sorumluluk metni şu anda okunamıyor. Vitrin paketi satın alma geçici ' +
      'olarak kapalı.',
  });
}

export const SHOWCASE_CARD_ALREADY_SUSPENDED_CODE = 'SHOWCASE_CARD_ALREADY_SUSPENDED';
export const SHOWCASE_CARD_NOT_SUSPENDED_CODE = 'SHOWCASE_CARD_NOT_SUSPENDED';
export const SHOWCASE_CARD_ALREADY_ARCHIVED_CODE = 'SHOWCASE_CARD_ALREADY_ARCHIVED';

export function showcaseCardAlreadySuspended() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_CARD_ALREADY_SUSPENDED_CODE,
    message: 'Bu kart zaten yayından kaldırılmış.',
  });
}

export function showcaseCardNotSuspended() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_CARD_NOT_SUSPENDED_CODE,
    message: 'Bu kart operatör kararıyla yayından kaldırılmış bir kart değil.',
  });
}

/**
 * The provider retired a card that is already retired.
 *
 * Separate from `showcaseCardLocked`, which is about editing: a provider whose
 * archive button is clicked twice is told the plain truth, because both facts
 * are their own.
 */
export function showcaseCardAlreadyArchived() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_CARD_ALREADY_ARCHIVED_CODE,
    message: 'Bu kart zaten arşivlenmiş.',
  });
}

export const SHOWCASE_ENTITLEMENT_REQUIRED_CODE = 'SHOWCASE_ENTITLEMENT_REQUIRED';
export const SHOWCASE_ENTITLEMENT_UNAVAILABLE_CODE = 'SHOWCASE_ENTITLEMENT_UNAVAILABLE';
export const SHOWCASE_ENTITLEMENT_MISSING_CODE = 'SHOWCASE_ENTITLEMENT_MISSING';
export const SHOWCASE_ENTITLEMENT_KIND_MISMATCH_CODE = 'SHOWCASE_ENTITLEMENT_KIND_MISMATCH';
export const SHOWCASE_REVISION_NEEDS_PUBLICATION_CODE = 'SHOWCASE_REVISION_NEEDS_PUBLICATION';

/** The provider has no usable right: a card cannot be opened or submitted without one. */
export function showcaseEntitlementRequired() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_ENTITLEMENT_REQUIRED_CODE,
    message: 'Vitrin kartı oluşturmak için kullanılabilir bir vitrin hakkınız olmalı. Önce vitrin paketi alın.',
  });
}

/** The named right was taken by another card (or expired) between the read and the write. */
export function showcaseEntitlementUnavailable() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_ENTITLEMENT_UNAVAILABLE_CODE,
    message: 'Bu vitrin hakkı artık kullanılabilir değil. Listeyi yenileyip tekrar deneyin.',
  });
}

/** An operator tried to approve a first version whose card holds no valid reserved right. */
export function showcaseEntitlementMissing() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_ENTITLEMENT_MISSING_CODE,
    message:
      'Bu kartın geçerli bir yayın hakkı yok. Sağlayıcı vitrin paketi almadan kart onaylanıp yayına alınamaz.',
  });
}

/** The chosen right was sold for a different card kind. */
export function showcaseEntitlementKindMismatch() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_ENTITLEMENT_KIND_MISMATCH_CODE,
    message: 'Seçtiğiniz vitrin hakkı bu kart türü için kullanılamaz.',
  });
}

/**
 * A card with a live version but no run behind it (a legacy approval) tried to
 * submit a revision. There is no terms snapshot to carry, so the card must be
 * published with a right first.
 */
export function showcaseRevisionNeedsPublication() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_REVISION_NEEDS_PUBLICATION_CODE,
    message: 'Bu kartı düzenlemeden önce bir vitrin hakkıyla yayına almanız gerekir.',
  });
}
