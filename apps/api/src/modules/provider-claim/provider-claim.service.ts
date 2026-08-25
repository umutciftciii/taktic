import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  NotificationStatus,
  Prisma,
  ProviderProfile,
  ProviderStatus,
  UserRole,
} from '@prisma/client';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { normalizeProviderEmail } from '../../common/provider-email';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { createSessionForUser, SessionMeta } from '../auth/session.util';
import { maskEmail } from '../notifications/mask';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import { SubmitProviderClaimDto } from './dto/submit-provider-claim.dto';
import {
  isClaimableProviderStatus,
  isProviderClaimEnabled,
  PROVIDER_CLAIM_PATH,
  PROVIDER_CLAIM_TOKEN_TTL_HOURS,
  getWebAppBaseUrl,
} from './provider-claim.config';
import {
  claimAlreadyCompletedException,
  claimEmailMissingException,
  claimLoginRequiredException,
  claimNotAvailableException,
  claimPasswordRequiredException,
  claimTokenInvalidException,
  emailBelongsToCustomerException,
  emailNotEligibleException,
  providerAlreadyHasProfileException,
  providerClaimDisabledException,
} from './provider-claim.errors';
import { ProviderClaimRateLimiter } from './provider-claim.rate-limiter';

/** Same shape as the customer activation and admin invite tokens. */
function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

function generateRawToken(): string {
  return randomBytes(32).toString('base64url');
}

function buildClaimUrl(rawToken: string): string {
  const base = getWebAppBaseUrl();
  const url = new URL(PROVIDER_CLAIM_PATH, `${base}/`);
  url.searchParams.set('token', rawToken);
  return url.toString();
}

/**
 * What the caller may do with a link that checked out.
 *
 * Everything else is a refusal and throws — see provider-claim.errors.ts. These
 * three are the only states a screen can act on, and `LOGIN_REQUIRED` is one of
 * them on purpose: it is not an error, it is "come back signed in", and the
 * token stays unspent while the person does that.
 */
export type ProviderClaimOutcome = 'NEW_ACCOUNT' | 'LINK_EXISTING_PROVIDER' | 'LOGIN_REQUIRED';

/** The safe status an admin screen may see about invitations. */
export type ProviderClaimInvitationState = 'ACTIVE' | 'USED' | 'EXPIRED';

export type ProviderClaimSummary = {
  /** Whether an invitation could be issued right now. */
  canInvite: boolean;
  /** Why not, as a stable code the screen can explain. Null when it can. */
  blockedCode: string | null;
  claimedAt: Date | null;
  ownership: 'UNCLAIMED' | 'CLAIMED' | 'OWNED';
  lastInvitation: {
    createdAt: Date;
    expiresAt: Date;
    state: ProviderClaimInvitationState;
    /** True when an admin issued it rather than the application's submission. */
    byAdmin: boolean;
  } | null;
};

type ClaimableProvider = Pick<
  ProviderProfile,
  'id' | 'userId' | 'email' | 'status' | 'businessName' | 'contactName' | 'city' | 'district'
>;

const claimProviderSelect = {
  id: true,
  userId: true,
  email: true,
  status: true,
  businessName: true,
  contactName: true,
  city: true,
  district: true,
} satisfies Prisma.ProviderProfileSelect;

type ResolvedClaim = {
  token: { id: string; expiresAt: Date };
  provider: ClaimableProvider;
  emailSnapshot: string;
  outcome: ProviderClaimOutcome;
  /** The account the application would be linked to, when one already exists. */
  existingUserId: string | null;
};

@Injectable()
export class ProviderClaimService {
  private readonly logger = new Logger('ProviderClaim');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationDispatcher) private readonly notifications: NotificationDispatcher,
    @Inject(ProviderClaimRateLimiter) private readonly rateLimiter: ProviderClaimRateLimiter,
  ) {}

  /**
   * Guest application path: an unowned application has just been created, so
   * mail its contact address a link to take it over.
   *
   * Best-effort by design, exactly like the customer activation twin. A refused
   * budget, a missing address or a dead transport must never fail or roll back
   * the application the visitor just submitted — they walked away with a
   * submitted application either way, and an admin can re-send the invitation.
   */
  async issueForNewApplication(providerId: string, meta: SessionMeta = {}): Promise<void> {
    if (!isProviderClaimEnabled()) {
      return;
    }

    try {
      const provider = await this.prisma.providerProfile.findUnique({
        where: { id: providerId },
        select: claimProviderSelect,
      });

      if (!provider || provider.userId || !provider.email) {
        return;
      }

      if (!isClaimableProviderStatus(provider.status)) {
        return;
      }

      await this.issueAndNotify(provider, null, meta);
    } catch (error) {
      // Only the class of failure, never the address or the link.
      this.logger.warn(
        `claim invitation not issued for application ${providerId}: ${describeError(error)}`,
      );
    }
  }

  /**
   * Admin path: re-send the invitation for an application that is still
   * unowned. Unlike the automatic path this one reports its refusals, because
   * an operator pressed a button and deserves to know what happened.
   *
   * Returns status only. No token, no URL and no address — the admin already
   * sees the application's address on the same screen, and putting the link in
   * an HTTP response would make the mailbox stop being the proof of ownership.
   */
  async resendForProvider(providerId: string, actorId: string, meta: SessionMeta = {}) {
    this.requireEnabled();

    const provider = await this.prisma.providerProfile.findUnique({
      where: { id: providerId },
      select: claimProviderSelect,
    });

    if (!provider) {
      throw new NotFoundException('Provider not found');
    }

    if (provider.userId) {
      throw claimAlreadyCompletedException();
    }

    if (!isClaimableProviderStatus(provider.status)) {
      throw claimNotAvailableException();
    }

    if (!normalizeProviderEmail(provider.email)) {
      throw claimEmailMissingException();
    }

    const issued = await this.issueAndNotify(provider, actorId, meta);

    return {
      status: 'ISSUED' as const,
      expiresAt: issued.expiresAt,
      delivery: issued.delivery,
    };
  }

  /**
   * Reads a link without spending it: what the screen needs to decide between
   * "set a password", "you already have an account, sign in" and "link them".
   *
   * Returns a masked address, never the raw one. Somebody holding this token
   * has proved nothing yet — the proof is that the link reached the mailbox,
   * and echoing the full address back would hand it to whoever else got hold of
   * the URL.
   */
  async validateRawToken(rawToken: string, user: AuthUser | null) {
    this.requireEnabled();
    const resolved = await this.resolveClaim(this.prisma, rawToken, user);

    return {
      valid: true as const,
      outcome: resolved.outcome,
      maskedEmail: maskEmail(resolved.emailSnapshot),
      expiresAt: resolved.token.expiresAt,
      application: {
        businessName: resolved.provider.businessName,
        city: resolved.provider.city,
        district: resolved.provider.district,
        status: resolved.provider.status,
      },
    };
  }

  /**
   * Spends the link and binds the application to an account.
   *
   * Serializable, because three separate facts have to hold together at commit
   * time: the token is still unspent, the application is still unowned, and the
   * address still belongs to nobody (or to exactly the signed-in provider). Of
   * two simultaneous submits precisely one can satisfy all three; the other
   * loses the conditional update and gets a business refusal rather than a 500.
   *
   * Nothing here writes User.role. A new account is created as PROVIDER, and an
   * existing one is used exactly as it is — no account ever changes what it is
   * because somebody followed a link.
   */
  async submit(dto: SubmitProviderClaimDto, user: AuthUser | null, meta: SessionMeta = {}) {
    this.requireEnabled();

    const rawToken = dto.token.trim();
    if (!rawToken) {
      throw claimTokenInvalidException();
    }

    // Hashing is deliberately outside the transaction: bcrypt at 12 rounds is
    // slow enough that doing it while holding a Serializable transaction open
    // would widen every conflict window in the flow. An unused hash is cheap.
    const passwordHash = dto.password ? await bcrypt.hash(dto.password, 12) : null;

    const result = await runSerializable(
      this.prisma,
      async (tx) => {
        const resolved = await this.resolveClaim(tx, rawToken, user);
        const now = new Date();

        if (resolved.outcome === 'LOGIN_REQUIRED') {
          // Left unspent on purpose: the person still has to come back through
          // this same link once they are signed in.
          throw claimLoginRequiredException();
        }

        if (resolved.outcome === 'NEW_ACCOUNT' && !passwordHash) {
          throw claimPasswordRequiredException();
        }

        const consumed = await tx.providerClaimToken.updateMany({
          where: { id: resolved.token.id, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });

        if (consumed.count !== 1) {
          throw claimTokenInvalidException();
        }

        const userId =
          resolved.outcome === 'NEW_ACCOUNT'
            ? await this.createProviderAccount(tx, resolved, passwordHash as string)
            : (resolved.existingUserId as string);

        // The conditional clause is the race guard: only an application that is
        // still unowned can become owned, so a concurrent winner leaves this
        // update matching nothing.
        const bound = await tx.providerProfile.updateMany({
          where: { id: resolved.provider.id, userId: null },
          data: { userId, claimedAt: now },
        });

        if (bound.count !== 1) {
          throw claimAlreadyCompletedException();
        }

        const session = await createSessionForUser(tx, userId, meta);

        return { userId, providerId: resolved.provider.id, session };
      },
      { label: 'providerClaim.submit' },
    );

    const account = await this.prisma.user.findUniqueOrThrow({
      where: { id: result.userId },
      select: { id: true, email: true, phone: true, name: true, role: true, isActive: true },
    });

    return {
      success: true as const,
      providerId: result.providerId,
      sessionId: result.session.sessionId,
      expiresAt: result.session.expiresAt,
      user: account,
    };
  }

  /**
   * Closes every live invitation for an application.
   *
   * Called when a status transition takes the application out of the claimable
   * set: a link that was mailed while an application was under review must not
   * survive its rejection or suspension. Runs on the caller's transaction so
   * the invalidation and the status change commit together.
   */
  async invalidateActiveTokens(
    tx: Pick<Prisma.TransactionClient, 'providerClaimToken'>,
    providerId: string,
  ): Promise<void> {
    await tx.providerClaimToken.updateMany({
      where: { providerId, usedAt: null },
      data: { usedAt: new Date() },
    });
  }

  /**
   * Ownership and invitation state for the admin application screen.
   *
   * Derived on read rather than stored: "can this be invited" depends on the
   * status, the address and the clock, and a column holding yesterday's answer
   * would be wrong the moment any of them changed.
   */
  async getClaimSummary(providerId: string): Promise<ProviderClaimSummary> {
    const provider = await this.prisma.providerProfile.findUnique({
      where: { id: providerId },
      select: { id: true, userId: true, email: true, status: true, claimedAt: true },
    });

    if (!provider) {
      throw new NotFoundException('Provider not found');
    }

    const latest = await this.prisma.providerClaimToken.findFirst({
      where: { providerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true, expiresAt: true, usedAt: true, createdById: true },
    });

    const ownership = provider.userId
      ? provider.claimedAt
        ? ('CLAIMED' as const)
        : ('OWNED' as const)
      : ('UNCLAIMED' as const);

    const blockedCode = resolveInviteBlockedCode(provider);

    return {
      canInvite: blockedCode === null,
      blockedCode,
      claimedAt: provider.claimedAt,
      ownership,
      lastInvitation: latest
        ? {
            createdAt: latest.createdAt,
            expiresAt: latest.expiresAt,
            state: invitationState(latest),
            byAdmin: latest.createdById !== null,
          }
        : null,
    };
  }

  private requireEnabled(): void {
    if (!isProviderClaimEnabled()) {
      throw providerClaimDisabledException();
    }
  }

  private async createProviderAccount(
    tx: Prisma.TransactionClient,
    resolved: ResolvedClaim,
    passwordHash: string,
  ): Promise<string> {
    try {
      const created = await tx.user.create({
        data: {
          role: UserRole.PROVIDER,
          name: resolved.provider.contactName,
          email: resolved.emailSnapshot,
          isActive: true,
          passwordHash,
          // Never a customer, so the origin marker stays empty — it describes
          // how a customer record came about and means nothing here.
          customerOrigin: null,
        },
        select: { id: true },
      });

      return created.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Somebody registered this address between the read and the write. The
        // application stays unowned; a fresh invitation will resolve to
        // whatever that account now is.
        throw emailNotEligibleException();
      }

      throw error;
    }
  }

  /**
   * The single place that decides what a link means. Both the read-only
   * validate call and the transactional submit go through it, so a screen can
   * never offer an action the submit would then refuse.
   */
  private async resolveClaim(
    client: Pick<Prisma.TransactionClient, 'providerClaimToken' | 'providerProfile' | 'user'>,
    rawToken: string,
    user: AuthUser | null,
  ): Promise<ResolvedClaim> {
    const record = await client.providerClaimToken.findUnique({
      where: { tokenHash: hashToken(rawToken.trim()) },
      select: {
        id: true,
        expiresAt: true,
        usedAt: true,
        emailSnapshot: true,
        provider: { select: claimProviderSelect },
      },
    });

    // Unknown, spent and expired are one answer: distinguishing them would turn
    // this endpoint into an oracle for guessed tokens.
    if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now()) {
      throw claimTokenInvalidException();
    }

    const provider = record.provider;
    const currentEmail = normalizeProviderEmail(provider.email);

    // The address moved after this link was mailed, so the link no longer
    // points at a mailbox anybody proved control of.
    if (!currentEmail || currentEmail !== record.emailSnapshot) {
      throw claimTokenInvalidException();
    }

    if (!isClaimableProviderStatus(provider.status)) {
      throw claimNotAvailableException();
    }

    if (provider.userId) {
      throw claimAlreadyCompletedException();
    }

    const existing = await client.user.findUnique({
      where: { email: currentEmail },
      select: {
        id: true,
        role: true,
        isActive: true,
        providerProfile: { select: { id: true } },
      },
    });

    const base = {
      token: { id: record.id, expiresAt: record.expiresAt },
      provider,
      emailSnapshot: currentEmail,
    };

    if (!existing) {
      return { ...base, outcome: 'NEW_ACCOUNT', existingUserId: null };
    }

    // A customer keeps being a customer. User.email is globally unique and an
    // account carries exactly one role, so there is no provider account this
    // address could become — and turning the customer into one is precisely
    // what must never happen behind a link.
    if (existing.role === UserRole.CUSTOMER) {
      throw emailBelongsToCustomerException();
    }

    if (existing.role !== UserRole.PROVIDER || !existing.isActive) {
      throw emailNotEligibleException();
    }

    // Holding the link is not the same as being the account. Until the owner of
    // that account is the one asking, the link buys nothing.
    if (!user || user.id !== existing.id) {
      return { ...base, outcome: 'LOGIN_REQUIRED', existingUserId: existing.id };
    }

    if (existing.providerProfile) {
      throw providerAlreadyHasProfileException();
    }

    return { ...base, outcome: 'LINK_EXISTING_PROVIDER', existingUserId: existing.id };
  }

  /**
   * Issues a fresh single-use token and mails it.
   *
   * The database work is one transaction: closing every older live token and
   * creating the new one must not be separable, or a crash between them would
   * leave an application with no live link and no way for the applicant to
   * notice.
   *
   * The send happens after that transaction commits, and deliberately so. The
   * dispatcher writes its audit row through its own connection *before* it
   * hands the message to the transport — that is what leaves a PENDING trace
   * when a process dies mid-send — and enrolling it here would both undo that
   * guarantee and hold a transaction open across network I/O. The dispatcher
   * never throws, so a dead transport leaves a valid token and a FAILED row,
   * which is exactly the state an admin re-send is for.
   */
  private async issueAndNotify(
    provider: ClaimableProvider,
    createdById: string | null,
    meta: SessionMeta,
  ): Promise<{ expiresAt: Date; delivery: NotificationStatus }> {
    const emailSnapshot = normalizeProviderEmail(provider.email);
    if (!emailSnapshot) {
      throw claimEmailMissingException();
    }

    await this.rateLimiter.assertWithinBudgets(provider.id, meta.ipAddress ?? null);

    const rawToken = generateRawToken();
    const expiresAt = new Date(Date.now() + PROVIDER_CLAIM_TOKEN_TTL_HOURS * 60 * 60 * 1000);

    await this.prisma.$transaction(async (tx) => {
      await tx.providerClaimToken.updateMany({
        where: { providerId: provider.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      await tx.providerClaimToken.create({
        data: {
          providerId: provider.id,
          tokenHash: hashToken(rawToken),
          emailSnapshot,
          expiresAt,
          createdById,
        },
      });
    });

    const outcome = await this.notifications.sendEmail(
      {
        template: 'provider-claim',
        to: emailSnapshot,
        subject: 'TakTic hizmet veren başvurunuzu hesabınıza bağlayın',
        actionUrl: buildClaimUrl(rawToken),
        data: {
          businessName: provider.businessName,
          expiresAt: expiresAt.toISOString(),
        },
      },
      { providerId: provider.id },
    );

    return { expiresAt, delivery: outcome.status };
  }
}

function resolveInviteBlockedCode(provider: {
  userId: string | null;
  email: string | null;
  status: ProviderStatus;
}): string | null {
  if (provider.userId) {
    return 'CLAIM_ALREADY_COMPLETED';
  }

  if (!isClaimableProviderStatus(provider.status)) {
    return 'CLAIM_NOT_AVAILABLE';
  }

  if (!normalizeProviderEmail(provider.email)) {
    return 'CLAIM_EMAIL_MISSING';
  }

  return null;
}

function invitationState(token: {
  usedAt: Date | null;
  expiresAt: Date;
}): ProviderClaimInvitationState {
  if (token.usedAt) {
    return 'USED';
  }

  return token.expiresAt.getTime() <= Date.now() ? 'EXPIRED' : 'ACTIVE';
}

/** Class of failure only — never a message that could carry an address. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name;
  }

  return 'UnknownError';
}
