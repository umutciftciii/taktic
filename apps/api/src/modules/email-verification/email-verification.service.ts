import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { emailVerificationUrl } from '../../common/web-routes';
import { PrismaService } from '../../prisma/prisma.service';
import { TransactionalMailService } from '../notifications/transactional-mail.service';
import {
  EMAIL_VERIFICATION_MAX_PER_WINDOW,
  EMAIL_VERIFICATION_TOKEN_TTL_DAYS,
  emailVerificationCooldownStart,
  emailVerificationExpiry,
  emailVerificationWindowStart,
} from './email-verification.constants';

/**
 * Proving that the person who registered controls the address they registered
 * with.
 *
 * This is a *different* lifecycle from CustomerActivationToken, and the
 * distinction is the whole reason both can exist without conflicting:
 *
 * - **Activation** sets the *first* password on an account the platform created
 *   on somebody's behalf during a guest request. It only applies while
 *   `passwordHash` is NULL and `customerOrigin` is AUTO_CREATED_REQUEST, and
 *   consuming it is what turns that account into a usable one.
 * - **Verification** records that an account which already has a password —
 *   because somebody registered it — really owns its mailbox. It changes no
 *   credential.
 *
 * No account can be in both states, so no link can ever be ambiguous. An
 * account that arrives through activation is marked verified by that act
 * itself: the activation link was delivered to the mailbox and consumed once,
 * which is exactly the proof this flow collects.
 *
 * Nothing is gated on `emailVerifiedAt` today. It records a fact rather than
 * granting or withholding anything, which keeps this addition from changing the
 * behaviour of any existing flow — deciding what verification should unlock is
 * a product question, and inventing an answer here would silently lock out
 * every account registered before the column existed.
 */
@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
  ) {}

  /**
   * Called by registration, right after the account exists.
   *
   * Best-effort: the account is committed and the person is signed in, so a
   * mail problem must not turn a completed registration into an error.
   */
  async issueForNewCustomer(userId: string): Promise<void> {
    try {
      await this.issue(userId);
    } catch (error) {
      this.logger.error(
        `Failed to issue a verification link for user ${userId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * The signed-in "send it again" path.
   *
   * Idempotent inside the cooldown: a second request made moments after the
   * first neither issues a token nor sends a mail, and reports the same
   * `accepted` the first one did. That is what stops a stuck page, an impatient
   * click or a client retry from filling an inbox — and it is why the response
   * carries no state a caller could poll on.
   */
  async resend(userId: string): Promise<{ status: 'accepted' }> {
    try {
      await this.issue(userId);
    } catch (error) {
      this.logger.error(
        `Failed to re-issue a verification link for user ${userId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    return { status: 'accepted' };
  }

  async validate(rawToken: string) {
    const record = await this.lookupActiveToken(rawToken);

    return {
      valid: true as const,
      email: record.emailSnapshot,
      expiresAt: record.expiresAt,
    };
  }

  /**
   * Consumes the link.
   *
   * Deliberately usable without a session: the link is opened from an inbox,
   * often in a different browser from the one that registered, and requiring a
   * session would make a verification mail useless to exactly the people most
   * likely to need it. The token is the proof.
   *
   * Already-verified is reported as success rather than as an error — the fact
   * the caller wanted recorded is recorded — but the token is still consumed,
   * so it cannot be replayed.
   */
  async confirm(rawToken: string): Promise<{ success: true; alreadyVerified: boolean }> {
    const record = await this.lookupActiveToken(rawToken);
    const now = new Date();
    const alreadyVerified = record.user.emailVerifiedAt !== null;

    try {
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.emailVerificationToken.updateMany({
          where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });

        if (claimed.count === 0) {
          throw new BadRequestException('Bağlantı geçersiz veya süresi dolmuş.');
        }

        // Conditional on the address still being the one the link was mailed
        // to. A link that went to an address the account has since left must
        // not verify the new one — the same rule the claim flow applies, for
        // the same reason.
        await tx.user.updateMany({
          where: { id: record.userId, email: record.emailSnapshot, emailVerifiedAt: null },
          data: { emailVerifiedAt: now },
        });

        await tx.emailVerificationToken.updateMany({
          where: { userId: record.userId, usedAt: null },
          data: { usedAt: now },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        throw new BadRequestException('Bağlantı geçersiz veya süresi dolmuş.');
      }

      throw error;
    }

    return { success: true, alreadyVerified };
  }

  private async issue(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        emailVerifiedAt: true,
      },
    });

    if (!user?.email || !user.isActive || user.role !== UserRole.CUSTOMER) {
      return;
    }

    if (user.emailVerifiedAt) {
      // Nothing left to prove.
      return;
    }

    const email = user.email.trim().toLowerCase();
    const now = new Date();

    const [recent, withinWindow] = await Promise.all([
      this.prisma.emailVerificationToken.count({
        where: { userId: user.id, createdAt: { gte: emailVerificationCooldownStart(now) } },
      }),
      this.prisma.emailVerificationToken.count({
        where: { userId: user.id, createdAt: { gte: emailVerificationWindowStart(now) } },
      }),
    ]);

    if (recent > 0 || withinWindow >= EMAIL_VERIFICATION_MAX_PER_WINDOW) {
      return;
    }

    const rawToken = generateRawToken();
    const expiresAt = emailVerificationExpiry(now);

    await this.prisma.$transaction(async (tx) => {
      await tx.emailVerificationToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: now },
      });

      await tx.emailVerificationToken.create({
        data: {
          userId: user.id,
          emailSnapshot: email,
          tokenHash: hashToken(rawToken),
          expiresAt,
        },
      });
    });

    await this.mail.sendEmailVerification({
      userId: user.id,
      email,
      fullName: user.name,
      verifyUrl: emailVerificationUrl(rawToken),
      expiryDays: EMAIL_VERIFICATION_TOKEN_TTL_DAYS,
    });
  }

  private async lookupActiveToken(rawToken: string) {
    const token = rawToken.trim();
    if (!token) {
      throw new BadRequestException('Bağlantı geçersiz veya süresi dolmuş.');
    }

    const record = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        id: true,
        userId: true,
        emailSnapshot: true,
        expiresAt: true,
        usedAt: true,
        user: { select: { email: true, isActive: true, emailVerifiedAt: true } },
      },
    });

    if (
      !record ||
      record.usedAt ||
      record.expiresAt.getTime() <= Date.now() ||
      !record.user.isActive ||
      record.user.email?.trim().toLowerCase() !== record.emailSnapshot
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
