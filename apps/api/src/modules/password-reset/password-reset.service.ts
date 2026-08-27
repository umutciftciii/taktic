import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { passwordResetUrl } from '../../common/web-routes';
import { PrismaService } from '../../prisma/prisma.service';
import { TransactionalMailService } from '../notifications/transactional-mail.service';
import {
  PASSWORD_RESET_MAX_PER_WINDOW,
  PASSWORD_RESET_TOKEN_TTL_MINUTES,
  passwordResetExpiry,
  passwordResetWindowStart,
} from './password-reset.constants';
import { ConfirmPasswordResetDto } from './dto/confirm-password-reset.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';

/**
 * Resetting a forgotten password.
 *
 * The security properties are the ones CustomerActivationToken and
 * ProviderClaimToken already establish in this codebase, applied to a different
 * fact:
 *
 * - only `sha256(raw)` is stored, so a database dump cannot be replayed;
 * - the raw token exists in memory for the length of one request and reaches
 *   the outside world in exactly one place, the URL inside the e-mail;
 * - it is single use and expiring, and the claim is a conditional UPDATE, so
 *   two concurrent submits cannot both win;
 * - issuing a new link closes every older live one, so at most one is valid.
 *
 * Two rules are specific to this flow.
 *
 * **The endpoint never says whether an address is registered.** Every request
 * returns the same body. A "no such account" answer would turn the reset form
 * into a membership oracle, which is the standard way an account-enumeration
 * bug is introduced.
 *
 * **A successful reset revokes every session.** A password is reset because it
 * may be known to somebody else; leaving that somebody's session alive would
 * make the reset cosmetic.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
  ) {}

  /**
   * Always resolves to the same value.
   *
   * Everything that could distinguish one address from another — the account
   * does not exist, it has no password, it is inactive, it is over its budget —
   * ends in the same silent return.
   */
  async request(dto: RequestPasswordResetDto): Promise<{ status: 'accepted' }> {
    const email = dto.email.trim().toLowerCase();

    try {
      await this.issueIfEligible(email);
    } catch (error) {
      // Even a failure is invisible to the caller: an error surfacing here for
      // one address and not another is itself an oracle.
      this.logger.error(
        'Failed to process a password reset request',
        error instanceof Error ? error.stack : String(error),
      );
    }

    return { status: 'accepted' };
  }

  /** Whether a link is still usable, for the page that renders the form. */
  async validate(rawToken: string) {
    const record = await this.lookupActiveToken(rawToken);

    return {
      valid: true as const,
      // The address the link belongs to, so the form can show whose password is
      // being set. Nothing else about the account: the token proves control of
      // this mailbox and nothing more.
      email: record.user.email,
      expiresAt: record.expiresAt,
    };
  }

  async confirm(dto: ConfirmPasswordResetDto): Promise<{ success: true }> {
    const record = await this.lookupActiveToken(dto.token);
    const passwordHash = await bcrypt.hash(dto.password, 12);
    const now = new Date();

    try {
      await this.prisma.$transaction(async (tx) => {
        // Claiming the token and setting the password happen together, and the
        // token row is only claimed while it is still unused and unexpired — so
        // of two concurrent submits exactly one wins and the other is told the
        // link is spent.
        const claimed = await tx.passwordResetToken.updateMany({
          where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });

        if (claimed.count === 0) {
          throw new BadRequestException('Bağlantı geçersiz veya süresi dolmuş.');
        }

        const updated = await tx.user.updateMany({
          where: { id: record.userId, isActive: true },
          data: { passwordHash },
        });

        if (updated.count === 0) {
          throw new BadRequestException('Bağlantı geçersiz veya süresi dolmuş.');
        }

        // Every other live link for this account dies with the one just used.
        await tx.passwordResetToken.updateMany({
          where: { userId: record.userId, usedAt: null },
          data: { usedAt: now },
        });

        // The old password may be known to somebody else, so every session it
        // opened goes with it. The person resetting signs in again with the
        // password they just chose.
        await tx.session.updateMany({
          where: { userId: record.userId, revokedAt: null },
          data: { revokedAt: now },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        throw new BadRequestException('Bağlantı geçersiz veya süresi dolmuş.');
      }

      throw error;
    }

    return { success: true };
  }

  /**
   * Issues and mails a link, or does nothing.
   *
   * An account with no password is deliberately not covered: it has never had
   * one to reset, and the activation link — a different token with a different
   * lifecycle — is how such an account gets its first. Registration already
   * routes those addresses there.
   */
  private async issueIfEligible(email: string): Promise<void> {
    if (!email) {
      return;
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, isActive: true, passwordHash: true },
    });

    if (!user?.email || !user.isActive || !user.passwordHash) {
      return;
    }

    const issuedRecently = await this.prisma.passwordResetToken.count({
      where: { userId: user.id, createdAt: { gte: passwordResetWindowStart() } },
    });

    if (issuedRecently >= PASSWORD_RESET_MAX_PER_WINDOW) {
      // Over budget for this account. Silent, like every other branch.
      return;
    }

    const rawToken = generateRawToken();
    const requestedAt = new Date();
    const expiresAt = passwordResetExpiry(requestedAt);

    await this.prisma.$transaction(async (tx) => {
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: requestedAt },
      });

      await tx.passwordResetToken.create({
        data: { userId: user.id, tokenHash: hashToken(rawToken), expiresAt },
      });
    });

    // The one place the raw token leaves this process. It travels inside the
    // URL and nowhere else: NotificationLog stores neither, and the delivering
    // adapter never logs a body.
    await this.mail.sendPasswordReset({
      userId: user.id,
      email: user.email,
      fullName: user.name,
      resetUrl: passwordResetUrl(rawToken),
      requestedAt,
      expiryMinutes: PASSWORD_RESET_TOKEN_TTL_MINUTES,
    });
  }

  private async lookupActiveToken(rawToken: string) {
    const token = rawToken.trim();
    if (!token) {
      throw new BadRequestException('Bağlantı geçersiz veya süresi dolmuş.');
    }

    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        usedAt: true,
        user: { select: { id: true, email: true, isActive: true, passwordHash: true } },
      },
    });

    // One message for every failure. Which of these it was is not something a
    // caller gets to learn.
    if (
      !record ||
      record.usedAt ||
      record.expiresAt.getTime() <= Date.now() ||
      !record.user.isActive ||
      !record.user.passwordHash
    ) {
      throw new BadRequestException('Bağlantı geçersiz veya süresi dolmuş.');
    }

    return record;
  }
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

function generateRawToken(): string {
  return randomBytes(32).toString('base64url');
}
