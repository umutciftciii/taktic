import { describe, expect, it } from 'vitest';
import { SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH } from '@taktic/shared';
import limits from '../../../packages/shared/limits.json';

/**
 * The description limit this app shows is the one the API enforces.
 *
 * The counter under the request form prints this number and the textarea's
 * `maxLength` is set from it, so if the web app ever resolved a different value
 * than the API does the form would promise room the server refuses — or refuse
 * room it allows. Both sides read `packages/shared/limits.json`; this asserts
 * the web half of that, and
 * `apps/api/test/request-description-limit.spec.ts` asserts the API half
 * against the same file.
 */
describe('service request description limit', () => {
  it('is the value carried by the shared limits file', () => {
    expect(SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH).toBe(limits.serviceRequestDescriptionMaxLength);
  });

  it('is 5000 characters', () => {
    expect(SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH).toBe(5000);
  });
});
