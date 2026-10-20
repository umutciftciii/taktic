import { BadRequestException, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Prisma, SourceChannel, UserRole } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { runSerializable } from '../../common/serializable-transaction';
import { emailVerificationUrl } from '../../common/web-routes';
import { PrismaService } from '../../prisma/prisma.service';
import { CampaignEngineHooks } from '../campaigns/engine/campaign-engine.hooks';
import { TransactionalMailService } from '../notifications/transactional-mail.service';
import {
  EMAIL_VERIFICATION_ALREADY_VERIFIED,
  EMAIL_VERIFICATION_EXPIRED,
  EMAIL_VERIFICATION_INVALID,
  EMAIL_VERIFICATION_MAX_PER_WINDOW,
  EMAIL_VERIFICATION_TOKEN_TTL_DAYS,
  type EmailVerificationRefusalCode,
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
 *
 * A provider account proves its address here too (AUTH-PROVIDER-CONTACT-001):
 * the same token, the same cooldown, the same single writer below, and only
 * the mail's wording differs. The proof is about the account, so a provider
 * with no business profile yet can collect it just the same.
 */

/** The two kinds of account that own a mailbox this flow can prove. */
const VERIFIABLE_ROLES: ReadonlySet<UserRole> = new Set([UserRole.CUSTOMER, UserRole.PROVIDER]);

export type VerifiedAccountKind = 'CUSTOMER' | 'PROVIDER';

@Injectable()
export class EmailVerificationService implements OnModuleInit {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
    @Inject(CampaignEngineHooks) private readonly campaignHooks: CampaignEngineHooks,
  ) {}

  /** `confirm` below is the one writer of EMAIL_VERIFIED for every kind of account; registered for PROVIDER accounts. */
  onModuleInit() {
    this.campaignHooks.registerFactWriter('EMAIL_VERIFIED', { module: 'email-verification', role: UserRole.PROVIDER });
    // CMP-006 PR-D: the confirmation route is the web application's, so a
    // proof confirmed through it carries WEB (see WEB_SURFACE_CHANNEL).
    this.campaignHooks.registerChannelSource('EMAIL_VERIFIED', SourceChannel.WEB, { module: 'email-verification' });
  }

  /**
   * Called by registration, right after the account exists — customer or
   * provider; the role on the row decides which mail goes out.
   *
   * Best-effort: the account is committed and the person is signed in, so a
   * mail problem must not turn a completed registration into an error.
   */
  async issueForNewAccount(userId: string): Promise<void> {
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

  /**
   * Reads a link without spending it — what the confirmation page does when it
   * is opened (STAGING-UAT-001 B3).
   *
   * Opening a page is a GET, and a GET is not only a person: mail security
   * scanners (Safe Links and the like), link previews and prefetchers follow
   * every link in a message. Spending the link here would let any of them
   * verify the account and leave the person who clicks a moment later in front
   * of "invalid". Only the button on that page — a POST — calls `confirm`.
   *
   * The answer carries no address: a link that leaks (a forwarded mail, a
   * screenshot of the bar) must not also leak whose it is.
   */
  async validate(rawToken: string): Promise<{ status: 'VALID'; accountKind: VerifiedAccountKind }> {
    const state = await this.classifyToken(rawToken);
    this.logOutcome('validate', state.kind === 'ACTIVE' ? 'VALID' : state.kind, accountKindOf(state));

    if (state.kind !== 'ACTIVE') {
      throw refusal(state);
    }

    return { status: 'VALID', accountKind: state.accountKind };
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
   * so it cannot be replayed. A link that was already spent is refused as
   * before, now with a code saying whether the account behind it is verified
   * (see {@link classifyToken}); nothing is written for it, so the campaign
   * fact below can still only be written once.
   */
  async confirm(
    rawToken: string,
    /** CMP-006 PR-D: the route's channel, never the request's; UNKNOWN when a caller cannot vouch. */
    sourceChannel: SourceChannel = SourceChannel.UNKNOWN,
  ): Promise<{ success: true; alreadyVerified: boolean; accountKind: VerifiedAccountKind }> {
    const state = await this.classifyToken(rawToken);
    if (state.kind !== 'ACTIVE') {
      this.logOutcome('confirm', state.kind, accountKindOf(state));
      throw refusal(state);
    }

    const { record, accountKind } = state;
    const now = new Date();
    const alreadyVerified = record.user.emailVerifiedAt !== null;

    try {
      // Serializable and replayed on a write conflict (S2B2): for a PROVIDER
      // account the campaign engine runs in this transaction once the proof
      // is written, and its conditional counters may collide with a
      // concurrent grant. The token and proof writes are unchanged.
      await runSerializable(
        this.prisma,
        async (tx) => {
          const claimed = await tx.emailVerificationToken.updateMany({
            where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
            data: { usedAt: now },
          });

          if (claimed.count === 0) {
            // Spent (or expired) between the read above and this write — two
            // clicks racing. Re-read below so the loser gets the same answer a
            // later click would.
            throw new ClaimLost();
          }

          // Conditional on the address still being the one the link was mailed
          // to. A link that went to an address the account has since left must
          // not verify the new one — the same rule the claim flow applies, for
          // the same reason.
          const proven = await tx.user.updateMany({
            where: { id: record.userId, email: record.emailSnapshot, emailVerifiedAt: null },
            data: { emailVerifiedAt: now },
          });

          await tx.emailVerificationToken.updateMany({
            where: { userId: record.userId, usedAt: null },
            data: { usedAt: now },
          });

          // CMP-002 fact callback: EMAIL_VERIFIED — the one writer of this
          // proof for every kind of account. `proven.count === 1` is the moment
          // the fact first became true for this user, inside the transaction
          // that made it durable; a replay (count 0) is not a new fact. The
          // hook resolves the PROVIDER profile itself and does nothing for a
          // customer's or an operator's proof. It only makes the eligibility
          // event durable — the evaluation runs later in the worker and can
          // never undo this proof. Last step of the transaction.
          if (proven.count === 1 && record.user.role === UserRole.PROVIDER) {
            await this.campaignHooks.accountFactProven(tx, record.userId, 'EMAIL_VERIFIED', sourceChannel);
          }
        },
        { label: 'emailVerification.confirm' },
      );
    } catch (error) {
      if (error instanceof ClaimLost) {
        const after = await this.classifyToken(rawToken);
        const lost: RefusedTokenState = after.kind === 'ACTIVE' ? { kind: 'INVALID' } : after;
        this.logOutcome('confirm', lost.kind, accountKindOf(lost));
        throw refusal(lost);
      }

      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        this.logOutcome('confirm', 'INVALID', accountKind);
        throw refusal({ kind: 'INVALID' });
      }

      throw error;
    }

    this.logOutcome('confirm', alreadyVerified ? 'CONFIRMED_ALREADY_VERIFIED' : 'VERIFIED', accountKind);
    return { success: true, alreadyVerified, accountKind };
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

    if (!user?.email || !user.isActive || !VERIFIABLE_ROLES.has(user.role)) {
      // An operator has no mailbox to prove here. Silent, like every other
      // reason not to send: the response says nothing about why.
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
      accountKind: user.role === UserRole.PROVIDER ? 'PROVIDER' : 'CUSTOMER',
    });
  }

  /**
   * What a link is, read without writing anything.
   *
   * ACTIVE is the only state `confirm` acts on — unchanged: unused, unexpired,
   * an active account, still at the address it was mailed to. Of the rest:
   *
   * - an unknown link, a deactivated account, or a link whose address the
   *   account has since left is INVALID, and says nothing more — those are the
   *   cases where a more precise answer would describe somebody else's account
   *   (or the account's new address), not the link the reader holds;
   * - a spent or expired link of an account that is verified at that very
   *   address is ALREADY_VERIFIED: the reader is the owner, the thing they came
   *   to do is done, and "invalid or expired" was simply the wrong answer;
   * - an unspent but expired link of an unverified account is EXPIRED, so the
   *   page can offer a fresh link instead of a shrug;
   * - a spent link of an unverified account was replaced by a newer one (a
   *   re-send spends the old link) and stays INVALID.
   */
  private async classifyToken(rawToken: string): Promise<TokenState> {
    const token = rawToken.trim();
    if (!token) {
      return { kind: 'INVALID' };
    }

    const record = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        id: true,
        userId: true,
        emailSnapshot: true,
        expiresAt: true,
        usedAt: true,
        user: { select: { email: true, isActive: true, emailVerifiedAt: true, role: true } },
      },
    });

    if (
      !record ||
      !record.user.isActive ||
      record.user.email?.trim().toLowerCase() !== record.emailSnapshot
    ) {
      return { kind: 'INVALID' };
    }

    // Which panel the confirmation page sends the reader on to. The token
    // holder is the account's owner, so naming the kind of account tells them
    // nothing they did not already know.
    const accountKind: VerifiedAccountKind =
      record.user.role === UserRole.PROVIDER ? 'PROVIDER' : 'CUSTOMER';
    const expired = record.expiresAt.getTime() <= Date.now();

    if (!record.usedAt && !expired) {
      return { kind: 'ACTIVE', record, accountKind };
    }

    if (record.user.emailVerifiedAt) {
      return { kind: 'ALREADY_VERIFIED', accountKind };
    }

    if (!record.usedAt) {
      return { kind: 'EXPIRED', accountKind };
    }

    return { kind: 'INVALID' };
  }

  /**
   * One line per answer, for telling a person's click from a scanner's and a
   * spent link from a dead one after the fact. Deliberately carries neither
   * the link, nor its hash, nor the account or its address.
   */
  private logOutcome(action: 'validate' | 'confirm', outcome: string, accountKind: VerifiedAccountKind | null) {
    this.logger.log(`email-verification ${action} outcome=${outcome} accountKind=${accountKind ?? 'unknown'}`);
  }
}

type ActiveTokenRecord = {
  id: string;
  userId: string;
  emailSnapshot: string;
  expiresAt: Date;
  usedAt: Date | null;
  user: { email: string | null; isActive: boolean; emailVerifiedAt: Date | null; role: UserRole };
};

type RefusedTokenState =
  | { kind: 'INVALID' }
  | { kind: 'EXPIRED'; accountKind: VerifiedAccountKind }
  | { kind: 'ALREADY_VERIFIED'; accountKind: VerifiedAccountKind };

type TokenState = { kind: 'ACTIVE'; record: ActiveTokenRecord; accountKind: VerifiedAccountKind } | RefusedTokenState;

/** Thrown inside the confirm transaction when the link was spent under it. */
class ClaimLost extends Error {}

const REFUSALS: Record<RefusedTokenState['kind'], { code: EmailVerificationRefusalCode; message: string }> = {
  // The wording every refusal used to carry, kept for the case it describes.
  INVALID: { code: EMAIL_VERIFICATION_INVALID, message: 'Bağlantı geçersiz veya süresi dolmuş.' },
  EXPIRED: { code: EMAIL_VERIFICATION_EXPIRED, message: 'Doğrulama bağlantısının süresi dolmuş.' },
  ALREADY_VERIFIED: {
    code: EMAIL_VERIFICATION_ALREADY_VERIFIED,
    message: 'Bu e-posta adresi zaten doğrulanmış.',
  },
};

/** Still a 400 for every refusal; `code` (and, for the link's owner, `accountKind`) is what changed. */
function refusal(state: RefusedTokenState): BadRequestException {
  const { code, message } = REFUSALS[state.kind];
  return new BadRequestException({
    statusCode: 400,
    code,
    message,
    ...(state.kind === 'INVALID' ? {} : { accountKind: state.accountKind }),
  });
}

function accountKindOf(state: TokenState): VerifiedAccountKind | null {
  return state.kind === 'INVALID' ? null : state.accountKind;
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

function generateRawToken(): string {
  return randomBytes(32).toString('base64url');
}
