import { ConflictException } from '@nestjs/common';

/**
 * Raised when registration hits the unique constraint on User.email.
 *
 * It is a distinct type (rather than a plain ConflictException) so the
 * controller can tell an e-mail collision apart from a phone collision and
 * offer the activation/claim path when the colliding account is an
 * auto-created, password-less customer.
 */
export class EmailAlreadyRegisteredException extends ConflictException {
  constructor(readonly email: string) {
    super('Email already registered');
  }
}
