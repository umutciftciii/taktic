import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizePhoneNumber } from '../phone-verification/phone.util';
import { resolveArea } from '../locations/turkey-locations';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateAccountProfileDto } from './dto/update-account-profile.dto';

/** The account has never had a password, so there is none to change. */
export const PASSWORD_NOT_SET_CODE = 'PASSWORD_NOT_SET';

/**
 * The cost factor every other password in this product is stored at — see
 * AuthService.register and PasswordResetService.confirm. A password that
 * travelled through this screen must not be cheaper to crack than one set at
 * registration.
 */
const PASSWORD_HASH_ROUNDS = 12;

export type AccountProfile = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  role: string;
  /**
   * Whether this account has a password at all.
   *
   * An account the platform created for a guest request has none until the
   * activation link is followed, and the settings screen reads this to send
   * that person to activation rather than to a form whose first field they
   * cannot fill.
   */
  hasPassword: boolean;
};

/**
 * A customer's own account: the three fields they may change, and their
 * password.
 *
 * Every method here takes the id from the session and nothing else. There is
 * no path parameter and no id in any body, so "a customer may only read and
 * write their own profile" is a property of the shape of this service rather
 * than a check somebody has to remember to write.
 */
@Injectable()
export class AccountService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async getProfile(userId: string): Promise<AccountProfile> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        city: true,
        role: true,
        passwordHash: true,
      },
    });

    if (!user) {
      throw new NotFoundException('Hesap bulunamadı.');
    }

    return toProfile(user);
  }

  async updateProfile(userId: string, dto: UpdateAccountProfileDto): Promise<AccountProfile> {
    const name = dto.name.trim();
    const phone = normalizeAccountPhone(dto.phone);
    const city = normalizeAccountCity(dto.city);

    // Asked before the write only so the customer gets the rule's own sentence
    // instead of a database error. It is not what enforces the rule — the
    // unique index on User.phone is, which is why P2002 is handled below too.
    await this.assertPhoneIsFree(userId, phone);

    try {
      const updated = await this.prisma.user.update({
        where: { id: userId },
        data: { name, phone, city },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          city: true,
          role: true,
          passwordHash: true,
        },
      });

      return toProfile(updated);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw phoneTakenException();
      }

      throw error;
    }
  }

  /**
   * Replaces the password, having proved the caller knows the current one.
   *
   * Three things happen together or not at all: the new hash is stored, every
   * *other* live session is revoked, and any unused password-reset link is
   * spent. The last two are the same reasoning PasswordResetService.confirm
   * already applies — a password is changed because the old one may be known
   * to somebody else, and leaving that somebody a live session or a live reset
   * link would make the change cosmetic.
   *
   * The session the request arrived on survives. Signing somebody out of the
   * browser they are standing in front of teaches nothing and costs them their
   * place; every other device has to sign in again.
   *
   * Nothing here ever reaches a log, a response body or a NotificationLog: the
   * two plaintext passwords exist as arguments to bcrypt and as a string
   * comparison, and nothing else in this method touches them.
   */
  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
    currentSessionId: string | null,
  ): Promise<{ success: true; otherSessionsRevoked: number }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true },
    });

    if (!user) {
      throw new NotFoundException('Hesap bulunamadı.');
    }

    if (!user.passwordHash) {
      // Nothing to verify and nothing to replace. Password reset deliberately
      // ignores these accounts too — the activation link is how such an
      // account gets its first password, and it proves mailbox ownership on
      // the way.
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: PASSWORD_NOT_SET_CODE,
        message:
          'Hesabınızda henüz bir şifre tanımlı değil. E-postanıza gönderilen etkinleştirme ' +
          'bağlantısıyla şifrenizi belirleyebilirsiniz.',
      });
    }

    const currentMatches = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!currentMatches) {
      // Says that the password did not match and nothing else. No hint about
      // the account, no count of attempts left, no distinction between "wrong"
      // and anything else that could be read as a fact about this hesap.
      throw new BadRequestException('Mevcut şifreniz doğrulanamadı.');
    }

    if (dto.newPassword !== dto.newPasswordConfirm) {
      throw new BadRequestException('Yeni şifre ile tekrarı aynı değil.');
    }

    // A plain comparison rather than a second bcrypt call: the line above has
    // already established that `currentPassword` is this account's password.
    if (dto.newPassword === dto.currentPassword) {
      throw new BadRequestException('Yeni şifreniz mevcut şifrenizden farklı olmalı.');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, PASSWORD_HASH_ROUNDS);
    const now = new Date();

    const otherSessionsRevoked = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });

      const revoked = await tx.session.updateMany({
        where: {
          userId,
          revokedAt: null,
          ...(currentSessionId ? { id: { not: currentSessionId } } : {}),
        },
        data: { revokedAt: now },
      });

      await tx.passwordResetToken.updateMany({
        where: { userId, usedAt: null },
        data: { usedAt: now },
      });

      return revoked.count;
    });

    return { success: true, otherSessionsRevoked };
  }

  /**
   * Refuses a number already on another account.
   *
   * The lookup covers the spellings the same number can be stored in rather
   * than only the canonical one. Every number written through this service is
   * E.164, but rows predate it: an account registered before this screen
   * existed carries whatever the visitor typed, and a check that only asked
   * about `+90555…` would happily hand a second account the `0555…` already on
   * file.
   */
  private async assertPhoneIsFree(userId: string, phone: string): Promise<void> {
    const existing = await this.prisma.user.findFirst({
      where: { phone: { in: equivalentPhoneSpellings(phone) }, id: { not: userId } },
      select: { id: true },
    });

    if (existing) {
      throw phoneTakenException();
    }
  }
}

function toProfile(user: {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  role: string;
  passwordHash: string | null;
}): AccountProfile {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    city: user.city,
    role: user.role,
    // The hash itself never leaves this function.
    hasPassword: Boolean(user.passwordHash),
  };
}

function phoneTakenException() {
  return new ConflictException('Bu telefon numarası başka bir hesaba ait.');
}

/**
 * The account's telephone number in the one canonical form.
 *
 * `normalizePhoneNumber` is the product's existing rule — the one the one-time
 * code path validates against — and it is reused rather than restated so the
 * profile screen cannot accept a number the rest of the platform would refuse
 * to text. Its own refusal is in English and aimed at an API caller, so it is
 * translated here into the sentence a customer standing in front of the form
 * can act on.
 */
function normalizeAccountPhone(value: string): string {
  try {
    return normalizePhoneNumber(value);
  } catch {
    throw new BadRequestException(
      'Telefon numarası geçerli görünmüyor. Örnek: 0555 123 45 67',
    );
  }
}

/**
 * The province in its canonical spelling, null when the customer cleared the
 * field, and undefined when they did not mention it at all.
 *
 * The three are different answers and Prisma reads them that way: undefined
 * leaves the column alone, which is what an omitted field in a PATCH has
 * always meant, and null is the explicit clearing the form's empty option
 * sends. Collapsing the two would let a caller that never named the field
 * erase a value nobody asked to lose.
 *
 * The DTO has already refused a value that names no province; this turns the
 * accepted spelling into the stored one, so "istanbul" and "İSTANBUL" become
 * the same "İstanbul" a request and a service area are compared against.
 */
function normalizeAccountCity(value: string | null | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const area = resolveArea({ city: trimmed });
  if (!area) {
    throw new BadRequestException('Seçilen il geçerli değil.');
  }

  return area.city;
}

/**
 * The ways one Turkish number may already be sitting in the database.
 *
 * Only spellings of the *same* number: the E.164 form, the national form with
 * its trunk zero, and the subscriber number on its own. Nothing here widens
 * what is accepted — the value being written is always the E.164 one.
 */
function equivalentPhoneSpellings(e164: string): string[] {
  const spellings = new Set<string>([e164]);

  if (e164.startsWith('+90') && e164.length === 13) {
    const subscriber = e164.slice(3);
    spellings.add(`0${subscriber}`);
    spellings.add(subscriber);
    spellings.add(`90${subscriber}`);
  }

  return [...spellings];
}
