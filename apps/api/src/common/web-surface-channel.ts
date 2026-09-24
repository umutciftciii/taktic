import { SourceChannel } from '@prisma/client';

/**
 * The channel of a business act that arrived through one of this API's web
 * application routes (CMP-006 PR-D).
 *
 * Derived from *which route handled the request*, never from anything in the
 * request: no header, query or body field is read for it. The routes that
 * pass it — checkout, package purchase, provider application, invitation
 * application, e-mail confirmation, phone OTP confirmation — are the web
 * application's own, and there is no other client of them today. A mobile
 * client, when it exists, gets routes of its own that pass MOBILE; until then
 * nothing produces MOBILE, and a channel no route can vouch for is UNKNOWN.
 *
 * Unrelated to `readRequestMeta().sourceChannel`, which is the client's own
 * declaration kept on a terms acceptance as a label.
 */
export const WEB_SURFACE_CHANNEL = SourceChannel.WEB;
