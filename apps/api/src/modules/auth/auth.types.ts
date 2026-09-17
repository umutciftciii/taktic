import { UserRole } from '@prisma/client';

export type AuthUser = {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  role: UserRole;
  isActive: boolean;
  /**
   * When the account proved its own `phone` (see User.phoneVerifiedAt).
   * Present on the session's own user; optional so callers that build an
   * AuthUser from a narrower read are not forced to carry it.
   */
  phoneVerifiedAt?: Date | null;
};
