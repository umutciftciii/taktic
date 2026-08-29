import { ConflictException, HttpStatus, NotFoundException } from '@nestjs/common';

/**
 * The complete, closed set of refusals the invitation flow may return.
 *
 * Two rules shape every one of them.
 *
 * 1. **The public route never distinguishes.** Unknown, spent, revoked, expired
 *    and "the category is no longer invitable" are one answer with one status,
 *    one code and one sentence. Splitting them would turn the route into an
 *    oracle: a caller could feed it guessed tokens and learn which ones ever
 *    existed, and a caller holding a dead link could learn whether the service
 *    behind it was withdrawn — which is a fact about the unreleased catalogue.
 * 2. **Nothing echoes the token.** No message, no code and no log line here
 *    carries it, its hash, or the URL it came in.
 */
export const PROVIDER_INVITE_ERROR_CODES = [
  'PROVIDER_INVITE_NOT_FOUND',
  'PROVIDER_INVITE_ALREADY_USED',
  'PROVIDER_INVITE_CATEGORY_NOT_INVITABLE',
] as const;

export type ProviderInviteErrorCode = (typeof PROVIDER_INVITE_ERROR_CODES)[number];

/**
 * One answer for "no such link", "already used", "revoked", "expired" and "the
 * service behind it is closed".
 *
 * 404 rather than 400 or 410 because that is the honest shape of what the
 * holder is being told: as far as this API is willing to say, there is nothing
 * at this address. The web page turns it into the site's ordinary 404 screen,
 * which is the same screen a mistyped URL produces — so even the rendered page
 * carries no signal.
 */
export function providerInviteNotFoundException() {
  return new NotFoundException({
    statusCode: HttpStatus.NOT_FOUND,
    error: 'Not Found',
    code: 'PROVIDER_INVITE_NOT_FOUND',
    message: 'Davet bağlantısı bulunamadı.',
  });
}

/**
 * Two applications arrived against one live link and this is the one that lost.
 *
 * Deliberately NOT folded into the 404 above, and it is the single exception to
 * the indistinguishability rule. It can only be reached by somebody who was
 * holding a link that *was* live when their submission started — they have
 * already been shown the category name, so nothing is disclosed — and what they
 * need to know is specific: their application was not recorded, and pressing
 * the button again will not help. A 404 would read as "the link never worked"
 * and send them back to the operator for a replacement they do not need.
 */
export function providerInviteAlreadyUsedException() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'PROVIDER_INVITE_ALREADY_USED',
    message: 'Bu davet bağlantısı az önce kullanıldı. Başvurunuz kaydedilmedi.',
  });
}

/**
 * An operator asked for a link against something that cannot have one.
 *
 * Only ever returned to a SUPER_ADMIN on the issuing route, so unlike the
 * refusals above it says what is wrong: a group is a folder and a router is a
 * question — neither describes work anybody performs — and a closed category is
 * one the marketplace has stopped selling, so recruiting supply for it would be
 * building for something nobody may request.
 */
export function providerInviteCategoryNotInvitableException() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'PROVIDER_INVITE_CATEGORY_NOT_INVITABLE',
    message:
      'Yalnızca yayında veya taslak durumdaki hizmet kategorileri için davet bağlantısı üretilebilir.',
  });
}
