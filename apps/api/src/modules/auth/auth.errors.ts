import { ConflictException, HttpStatus } from '@nestjs/common';
import {
  CUSTOMER_IDENTITY_CONFLICT_CODE,
  CUSTOMER_IDENTITY_CONFLICT_MESSAGE,
} from '../../common/account-identity';

/**
 * Raised when registration meets an account that already holds the address
 * or the number — from the pre-read, or from the unique index when a race was
 * lost.
 *
 * Over the wire it is the one canonical refusal: `CUSTOMER_IDENTITY_CONFLICT`
 * with a sentence that does not say which of the two collided. The field is
 * kept on the instance only so the controller can offer the activation path
 * when the colliding account is an auto-created, password-less customer —
 * and it is `null` when the number and the address each matched a different
 * account, because then there is no one account to activate.
 */
export class AccountIdentityConflictException extends ConflictException {
  constructor(readonly field: 'email' | 'phone' | null, readonly value: string | null) {
    super({
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      code: CUSTOMER_IDENTITY_CONFLICT_CODE,
      message: CUSTOMER_IDENTITY_CONFLICT_MESSAGE,
    });
  }
}
