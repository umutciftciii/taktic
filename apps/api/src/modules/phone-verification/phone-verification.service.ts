import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { CampaignEngineHooks } from '../campaigns/engine/campaign-engine.hooks';
import { maskPhone } from '../notifications/mask';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import { RequestPublishOutbox } from '../notifications/request-publish-outbox.service';
import { MarketplacePublishSettingsService } from '../operations-settings/marketplace-publish-settings.service';
import { ServiceRequestsService } from '../service-requests/service-requests.service';
import {
  OTP_CODE_LENGTH,
  OTP_LOCK_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_SENDS_PER_IP_PER_HOUR,
  OTP_MAX_SENDS_PER_PHONE_PER_HOUR,
  OTP_RATE_WINDOW_MINUTES,
  OTP_TTL_MINUTES,
} from './phone-verification.constants';
import { isPhoneVerificationTestBypassMatch } from './phone-verification-test-bypass.config';
import { normalizePhoneNumber } from './phone.util';

export type VerificationRequestMeta = {
  ipAddress: string | null;
  userAgent: string | null;
};

const BCRYPT_ROUNDS = 10;

@Injectable()
export class PhoneVerificationService implements OnModuleInit {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationDispatcher) private readonly notifications: NotificationDispatcher,
    @Inject(MarketplacePublishSettingsService)
    private readonly publishSettings: MarketplacePublishSettingsService,
    @Inject(ServiceRequestsService) private readonly requests: ServiceRequestsService,
    @Inject(RequestPublishOutbox) private readonly publishOutbox: RequestPublishOutbox,
    @Inject(CampaignEngineHooks) private readonly campaignHooks: CampaignEngineHooks,
  ) {}

  /** `verifyAccountCode` below is the PROVIDER writer of PHONE_VERIFIED; the request flow's CUSTOMER write is not a campaign fact. */
  onModuleInit() {
    this.campaignHooks.registerFactWriter('PHONE_VERIFIED', { module: 'phone-verification', role: UserRole.PROVIDER });
  }

  async sendCode(requestId: string, user: AuthUser, meta: VerificationRequestMeta) {
    const serviceRequest = await this.getOwnedRequest(requestId, user);

    if (serviceRequest.phoneVerifiedAt) {
      throw new ConflictException('Bu talebin telefonu zaten doğrulanmış.');
    }

    const normalizedPhone = normalizePhoneNumber(serviceRequest.customerPhone);
    const now = new Date();
    const windowStart = new Date(now.getTime() - OTP_RATE_WINDOW_MINUTES * 60 * 1000);

    const [phoneSends, ipSends] = await Promise.all([
      this.prisma.phoneVerification.count({
        where: { normalizedPhone, createdAt: { gte: windowStart } },
      }),
      meta.ipAddress
        ? this.prisma.phoneVerification.count({
            where: { ipAddress: meta.ipAddress, createdAt: { gte: windowStart } },
          })
        : Promise.resolve(0),
    ]);

    if (
      phoneSends >= OTP_MAX_SENDS_PER_PHONE_PER_HOUR ||
      ipSends >= OTP_MAX_SENDS_PER_IP_PER_HOUR
    ) {
      // One response for both budgets, and it says nothing about which one was
      // hit or whether the number is known to us.
      throw new HttpException(
        'Çok fazla doğrulama kodu istendi. Lütfen bir süre sonra tekrar deneyin.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = generateCode();
    const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
    const expiresAt = new Date(now.getTime() + OTP_TTL_MINUTES * 60 * 1000);

    await this.prisma.$transaction(async (tx) => {
      // At most one code is ever live for a request: issuing a new one retires
      // whatever was outstanding, so an old SMS cannot be replayed.
      await tx.phoneVerification.updateMany({
        where: { requestId, normalizedPhone, consumedAt: null },
        data: { consumedAt: now },
      });

      await tx.phoneVerification.create({
        data: {
          normalizedPhone,
          codeHash,
          expiresAt,
          resendCount: phoneSends,
          lastSentAt: now,
          requestId,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
      });
    });

    // Outside the transaction on purpose: a transport failure is recorded as
    // FAILED but must not undo the code we just issued.
    const outcome = await this.notifications.sendSms(
      {
        template: 'phone-verification-code',
        to: normalizedPhone,
        code,
        expiresInMinutes: OTP_TTL_MINUTES,
      },
      { requestId, userId: serviceRequest.customerId },
    );

    return {
      status: 'sent' as const,
      delivery: outcome.status,
      maskedPhone: maskPhone(normalizedPhone),
      expiresAt,
      // The code itself is never returned, in any environment.
    };
  }

  async verifyCode(requestId: string, user: AuthUser, rawCode: string, meta: VerificationRequestMeta) {
    const serviceRequest = await this.getOwnedRequest(requestId, user);

    if (serviceRequest.phoneVerifiedAt) {
      throw new ConflictException('Bu talebin telefonu zaten doğrulanmış.');
    }

    const code = normalizeCode(rawCode);
    const normalizedPhone = normalizePhoneNumber(serviceRequest.customerPhone);

    const outcome = await runSerializable(
      this.prisma,
      async (tx) => {
        const now = new Date();
        const candidate = await tx.phoneVerification.findFirst({
          where: { requestId, normalizedPhone, consumedAt: null },
          orderBy: { createdAt: 'desc' },
        });

        if (!candidate || candidate.expiresAt <= now) {
          return { ok: false as const };
        }

        if (candidate.lockedUntil && candidate.lockedUntil > now) {
          return { ok: false as const };
        }

        const accepted = await acceptedCode(code, candidate.codeHash, normalizedPhone, now);

        if (!accepted) {
          const attemptCount = candidate.attemptCount + 1;
          // The increment is committed by this transaction and the caller
          // throws afterwards — throwing here would roll the counter back and
          // hand an attacker unlimited guesses.
          await tx.phoneVerification.update({
            where: { id: candidate.id },
            data: {
              attemptCount,
              ...(attemptCount >= OTP_MAX_ATTEMPTS
                ? { lockedUntil: new Date(now.getTime() + OTP_LOCK_MINUTES * 60 * 1000) }
                : {}),
            },
          });

          return { ok: false as const };
        }

        await tx.phoneVerification.update({
          where: { id: candidate.id },
          data: { consumedAt: now, verifiedByTestBypass: accepted === 'test-bypass' },
        });

        // Guarded so the verification of one request can never stamp another,
        // and so a replay cannot move an already-verified timestamp.
        const verified = await tx.serviceRequest.updateMany({
          where: { id: requestId, phoneVerifiedAt: null },
          data: { phoneVerifiedAt: now },
        });

        if (verified.count !== 1) {
          return { ok: false as const };
        }

        // The account earns the proof too — when the owner themself entered
        // the code, and the number they proved is the account's own number
        // as it stands *now*. The `phone` clause in the WHERE is what makes
        // that safe against a number changed while the code was in flight:
        // the old number's proof cannot land on the new one. An alternate
        // contact's number never matches, an operator entering the code on
        // the customer's behalf is not the owner, and a proof already on file
        // is left where it is.
        //
        // The account's number is compared in E.164 (older rows may still
        // carry another spelling — AUTH-REG-002) and the write is guarded on
        // the exact stored string, so it lands only on the row as it was read.
        if (user.role === UserRole.CUSTOMER && serviceRequest.customerId === user.id) {
          const account = await tx.user.findUnique({
            where: { id: user.id },
            select: { phone: true },
          });
          if (account?.phone && sameNumber(account.phone, normalizedPhone)) {
            await tx.user.updateMany({
              where: { id: user.id, phone: account.phone, phoneVerifiedAt: null },
              data: { phoneVerifiedAt: now },
            });
            // No CMP-002 fact callback here: this branch is CUSTOMER-only, and
            // a customer has no provider profile for a campaign fact to attach
            // to. The PROVIDER writer is `verifyAccountCode` below.
          }
        }

        // Verification was the last thing the request waited for: publish it
        // here, in the same transaction, so "verified" and "live" are one
        // commit. The switch is read outside the transaction — it is an
        // operations decision that does not change inside one — and the
        // publish itself is conditional on SUBMITTED and an open gate, so a
        // request an operator already moved, or a vitrin lead, is left alone.
        const published =
          (await this.publishSettings.isAutoPublishEnabled()) &&
          (await this.requests.publishRequestInTransaction(tx, requestId, now));

        return { ok: true as const, verifiedAt: now, published };
      },
      { label: 'phoneVerification.verifyCode' },
    );

    if (!outcome.ok) {
      throw invalidCodeException();
    }

    if (outcome.published) {
      // After the commit and never awaited: the intents are durable, and the
      // customer's response does not wait on a mail provider.
      this.publishOutbox.deliverSoon();
    }

    void meta;
    return { status: 'verified' as const, phoneVerifiedAt: outcome.verifiedAt };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // The account's own number (AUTH-PROVIDER-CONTACT-001)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Issues a code against the signed-in provider's own `User.phone`.
   *
   * The third kind of row this table holds: no request behind it and an
   * account in front of it (`userId` set, `requestId` null). It shares the
   * hash, the attempt budget, the lock and both send budgets with the other
   * two kinds, and nothing else — the lead path cannot retire it and cannot
   * redeem it (see `sendStandaloneCode` and `findRedeemableVerification`).
   *
   * The number is the account's as stored *now*, read fresh rather than from
   * the session, so a code is never issued for a number the row no longer
   * carries. The account is named by the session alone: no id travels in the
   * request, so there is nothing to probe.
   */
  async sendAccountCode(user: AuthUser, meta: VerificationRequestMeta) {
    const account = await this.getAccountForProof(user);
    if (!account.normalizedPhone) {
      throw accountPhoneMissingException();
    }

    const normalizedPhone = account.normalizedPhone;
    const now = new Date();
    const windowStart = new Date(now.getTime() - OTP_RATE_WINDOW_MINUTES * 60 * 1000);

    const [phoneSends, ipSends] = await Promise.all([
      this.prisma.phoneVerification.count({
        where: { normalizedPhone, createdAt: { gte: windowStart } },
      }),
      meta.ipAddress
        ? this.prisma.phoneVerification.count({
            where: { ipAddress: meta.ipAddress, createdAt: { gte: windowStart } },
          })
        : Promise.resolve(0),
    ]);

    if (
      phoneSends >= OTP_MAX_SENDS_PER_PHONE_PER_HOUR ||
      ipSends >= OTP_MAX_SENDS_PER_IP_PER_HOUR
    ) {
      throw new HttpException(
        'Çok fazla doğrulama kodu istendi. Lütfen bir süre sonra tekrar deneyin.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = generateCode();
    const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
    const expiresAt = new Date(now.getTime() + OTP_TTL_MINUTES * 60 * 1000);

    await this.prisma.$transaction(async (tx) => {
      // One live code per account, exactly as per request and per lead number.
      await tx.phoneVerification.updateMany({
        where: { userId: user.id, consumedAt: null },
        data: { consumedAt: now },
      });

      await tx.phoneVerification.create({
        data: {
          normalizedPhone,
          codeHash,
          expiresAt,
          resendCount: phoneSends,
          lastSentAt: now,
          requestId: null,
          userId: user.id,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
      });
    });

    const outcome = await this.notifications.sendSms(
      {
        template: 'phone-verification-code',
        to: normalizedPhone,
        code,
        expiresInMinutes: OTP_TTL_MINUTES,
      },
      { userId: user.id },
    );

    return {
      status: 'sent' as const,
      delivery: outcome.status,
      maskedPhone: maskPhone(normalizedPhone),
      expiresAt,
      // The code itself is never returned, in any environment.
    };
  }

  /**
   * Checks a code against the account's live code and, if it is right, writes
   * the account's proof — and nothing else. No request is published, no lead
   * is bound, no outbox is woken.
   *
   * The code proves the number it was sent to. If the account's number is not
   * that number any more (no provider path changes it today; the check is
   * what keeps the proof honest whatever path appears), the code lands
   * nowhere. The write is guarded on the exact stored spelling of the number
   * and on the column being NULL, so a replay or a race cannot move a proof
   * already on file.
   */
  async verifyAccountCode(user: AuthUser, rawCode: string, meta: VerificationRequestMeta) {
    const code = normalizeCode(rawCode);
    const account = await this.getAccountForProof(user, { requirePhone: false });

    const outcome = await runSerializable(
      this.prisma,
      async (tx) => {
        const now = new Date();
        const candidate = await tx.phoneVerification.findFirst({
          where: { userId: user.id, requestId: null, consumedAt: null },
          orderBy: { createdAt: 'desc' },
        });

        if (!candidate || candidate.expiresAt <= now) {
          return { ok: false as const, reason: 'invalid' as const };
        }

        if (candidate.lockedUntil && candidate.lockedUntil > now) {
          return { ok: false as const, reason: 'invalid' as const };
        }

        // The number the code was sent to must still be the account's number.
        if (!account.normalizedPhone || candidate.normalizedPhone !== account.normalizedPhone) {
          return { ok: false as const, reason: 'invalid' as const };
        }

        const accepted = await acceptedCode(code, candidate.codeHash, candidate.normalizedPhone, now);

        if (!accepted) {
          const attemptCount = candidate.attemptCount + 1;
          // Committed by this transaction; the caller throws afterwards — the
          // same reasoning as the two paths above.
          await tx.phoneVerification.update({
            where: { id: candidate.id },
            data: {
              attemptCount,
              ...(attemptCount >= OTP_MAX_ATTEMPTS
                ? { lockedUntil: new Date(now.getTime() + OTP_LOCK_MINUTES * 60 * 1000) }
                : {}),
            },
          });

          return { ok: false as const, reason: 'invalid' as const };
        }

        await tx.phoneVerification.update({
          where: { id: candidate.id },
          data: { consumedAt: now, verifiedByTestBypass: accepted === 'test-bypass' },
        });

        const proven = await tx.user.updateMany({
          where: { id: user.id, phone: account.phone, phoneVerifiedAt: null },
          data: { phoneVerifiedAt: now },
        });

        if (proven.count !== 1) {
          // Somebody — a parallel verify — got there first, or the number
          // moved between the read and the write. The code is spent; the
          // proof on file is left where it is.
          return { ok: false as const, reason: 'already' as const };
        }

        // CMP-002 fact callback: PHONE_VERIFIED — the PROVIDER writer of this
        // proof. `proven.count === 1` is the moment the fact first became true
        // for this account, inside the transaction that made it durable, and
        // this is that transaction's last step. The hook only makes the
        // eligibility event durable; the evaluation runs later in the worker
        // and can never undo this proof.
        await this.campaignHooks.accountFactProven(tx, user.id, 'PHONE_VERIFIED');

        return { ok: true as const, verifiedAt: now };
      },
      { label: 'phoneVerification.verifyAccountCode' },
    );

    if (!outcome.ok) {
      throw outcome.reason === 'already' ? accountAlreadyVerifiedException() : invalidCodeException();
    }

    void meta;
    return { status: 'verified' as const, phoneVerifiedAt: outcome.verifiedAt };
  }

  /**
   * The account as it stands, or the refusal that says why no code can be
   * issued for it. Both refusals are about the caller's own account and name
   * nothing else, so neither can be used to learn about another number.
   */
  private async getAccountForProof(
    user: AuthUser,
    options: { requirePhone?: boolean } = {},
  ): Promise<{ phone: string | null; normalizedPhone: string | null }> {
    if (user.role !== UserRole.PROVIDER) {
      // The guard already refused everybody else; this is the service's own
      // word on it, so a future caller cannot route around the guard.
      throw new ForbiddenException('Yalnızca hizmet veren hesapları için.');
    }

    const account = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { phone: true, phoneVerifiedAt: true, isActive: true },
    });

    if (!account || !account.isActive) {
      throw new ForbiddenException('User is inactive');
    }

    if (account.phoneVerifiedAt) {
      throw accountAlreadyVerifiedException();
    }

    let normalizedPhone: string | null = null;
    if (account.phone) {
      try {
        normalizedPhone = normalizePhoneNumber(account.phone);
      } catch {
        normalizedPhone = null;
      }
    }

    if (options.requirePhone !== false && !normalizedPhone) {
      throw accountPhoneMissingException();
    }

    return { phone: account.phone, normalizedPhone };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Verification before a request exists
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Issues a code against a telephone number with no request behind it yet.
   *
   * ## Why this exists at all
   *
   * The two methods above verify a number that is already written on a stored
   * request: the request comes first, the proof comes after, and what the proof
   * gates is *moderation* — an unverified request simply does not get approved.
   * That ordering is right for the marketplace form, where an operator stands
   * between the customer and every business.
   *
   * The vitrin lead has no operator in the middle. It reaches one business
   * directly, the moment it is written, and it starts a clock that business is
   * measured against. So the proof has to come **first**, and that needs a
   * verification that can exist before the request does.
   *
   * `PhoneVerification.requestId` has always been nullable, so a request-less
   * row was already representable; nothing wrote one until now.
   *
   * ## What makes it single-use
   *
   * There is no token and nothing to store. The proof *is* the consumed row:
   * {@link findRedeemableVerification} looks for a row that is consumed,
   * recent, and **not yet bound to a request**, and the lead transaction binds
   * it to the request it creates. A second lead finds nothing to redeem.
   *
   * The rate budgets are the same two counters the request-bound path uses, on
   * the same window, so opening this path adds no new send capacity to a
   * telephone number or an address.
   */
  async sendStandaloneCode(rawPhone: string, meta: VerificationRequestMeta) {
    const normalizedPhone = normalizePhoneNumber(rawPhone);
    const now = new Date();
    const windowStart = new Date(now.getTime() - OTP_RATE_WINDOW_MINUTES * 60 * 1000);

    const [phoneSends, ipSends] = await Promise.all([
      this.prisma.phoneVerification.count({
        where: { normalizedPhone, createdAt: { gte: windowStart } },
      }),
      meta.ipAddress
        ? this.prisma.phoneVerification.count({
            where: { ipAddress: meta.ipAddress, createdAt: { gte: windowStart } },
          })
        : Promise.resolve(0),
    ]);

    if (
      phoneSends >= OTP_MAX_SENDS_PER_PHONE_PER_HOUR ||
      ipSends >= OTP_MAX_SENDS_PER_IP_PER_HOUR
    ) {
      throw new HttpException(
        'Çok fazla doğrulama kodu istendi. Lütfen bir süre sonra tekrar deneyin.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = generateCode();
    const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
    const expiresAt = new Date(now.getTime() + OTP_TTL_MINUTES * 60 * 1000);

    await this.prisma.$transaction(async (tx) => {
      // At most one live code per number on this path, exactly as on the other:
      // issuing a new one retires whatever was outstanding, so an old SMS
      // cannot be replayed. Scoped to `requestId: null` so it can never retire
      // a code somebody is in the middle of using on one of their requests.
      // …and scoped to `userId: null` so it never retires a provider's own
      // account code for the same number (AUTH-PROVIDER-CONTACT-001).
      await tx.phoneVerification.updateMany({
        where: { requestId: null, userId: null, normalizedPhone, consumedAt: null },
        data: { consumedAt: now },
      });

      await tx.phoneVerification.create({
        data: {
          normalizedPhone,
          codeHash,
          expiresAt,
          resendCount: phoneSends,
          lastSentAt: now,
          requestId: null,
          userId: null,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
      });
    });

    const outcome = await this.notifications.sendSms({
      template: 'phone-verification-code',
      to: normalizedPhone,
      code,
      expiresInMinutes: OTP_TTL_MINUTES,
    });

    return {
      status: 'sent' as const,
      delivery: outcome.status,
      maskedPhone: maskPhone(normalizedPhone),
      expiresAt,
    };
  }

  /**
   * Checks a code against a request-less verification and marks it consumed.
   *
   * Consuming is all it does. Nothing is stamped anywhere else, because there
   * is no request yet to stamp — the consumed row is the receipt, and the lead
   * endpoint redeems it.
   *
   * The window between consuming and redeeming is deliberately short (see
   * {@link findRedeemableVerification}). A proof that stayed good for a day
   * would be a proof somebody could collect once and spend whenever.
   */
  async verifyStandaloneCode(rawPhone: string, rawCode: string, meta: VerificationRequestMeta) {
    const normalizedPhone = normalizePhoneNumber(rawPhone);
    const code = normalizeCode(rawCode);

    const outcome = await runSerializable(
      this.prisma,
      async (tx) => {
        const now = new Date();
        const candidate = await tx.phoneVerification.findFirst({
          where: { requestId: null, userId: null, normalizedPhone, consumedAt: null },
          orderBy: { createdAt: 'desc' },
        });

        if (!candidate || candidate.expiresAt <= now) {
          return { ok: false as const };
        }

        if (candidate.lockedUntil && candidate.lockedUntil > now) {
          return { ok: false as const };
        }

        const accepted = await acceptedCode(code, candidate.codeHash, normalizedPhone, now);

        if (!accepted) {
          const attemptCount = candidate.attemptCount + 1;
          // Committed by this transaction, and the caller throws afterwards.
          // Throwing here would roll the counter back and hand an attacker
          // unlimited guesses — the same reasoning as the request-bound path.
          await tx.phoneVerification.update({
            where: { id: candidate.id },
            data: {
              attemptCount,
              ...(attemptCount >= OTP_MAX_ATTEMPTS
                ? { lockedUntil: new Date(now.getTime() + OTP_LOCK_MINUTES * 60 * 1000) }
                : {}),
            },
          });

          return { ok: false as const };
        }

        await tx.phoneVerification.update({
          where: { id: candidate.id },
          data: { consumedAt: now, verifiedByTestBypass: accepted === 'test-bypass' },
        });

        return { ok: true as const, verifiedAt: now };
      },
      { label: 'phoneVerification.verifyStandaloneCode' },
    );

    if (!outcome.ok) {
      throw invalidCodeException();
    }

    void meta;
    return {
      status: 'verified' as const,
      verifiedAt: outcome.verifiedAt,
      maskedPhone: maskPhone(normalizedPhone),
    };
  }

  /**
   * The proof a vitrin lead redeems: a consumed, recent, still-unbound
   * verification for this number.
   *
   * Three conditions and each one closes a different door.
   *
   * - **`consumedAt` is not null** — somebody entered the code.
   * - **`requestId` is null** — it has not already paid for a lead. The lead
   *   transaction sets this column, which is what makes one code buy one lead
   *   with no extra table and no token to leak.
   * - **consumed inside the window** — a proof collected this morning cannot
   *   open a lead this evening.
   *
   * Read inside the caller's transaction, and bound in the same one, so two
   * simultaneous submissions cannot both redeem it.
   */
  async findRedeemableVerification(
    tx: Prisma.TransactionClient,
    rawPhone: string,
    now: Date,
    windowMinutes: number,
  ): Promise<{ id: string } | null> {
    const normalizedPhone = normalizePhoneNumber(rawPhone);
    const since = new Date(now.getTime() - windowMinutes * 60 * 1000);

    return tx.phoneVerification.findFirst({
      where: {
        requestId: null,
        // Never an account's own proof: a provider who verified their account
        // number a minute ago has not proven anybody's lead.
        userId: null,
        normalizedPhone,
        consumedAt: { not: null, gte: since },
      },
      orderBy: { consumedAt: 'desc' },
      select: { id: true },
    });
  }

  /**
   * The request must exist and belong to the caller. Anything else — another
   * customer, a provider, a guest request with no owner — is refused, and the
   * refusal never depends on the phone number, so this cannot be used to probe
   * which numbers the platform knows.
   */
  private async getOwnedRequest(requestId: string, user: AuthUser) {
    const serviceRequest = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        customerId: true,
        customerPhone: true,
        phoneVerifiedAt: true,
      },
    });

    if (!serviceRequest) {
      throw new NotFoundException('Service request not found');
    }

    if (user.role === UserRole.SUPER_ADMIN) {
      return serviceRequest;
    }

    if (
      user.role !== UserRole.CUSTOMER ||
      !serviceRequest.customerId ||
      serviceRequest.customerId !== user.id
    ) {
      throw new ForbiddenException('Service request access denied');
    }

    return serviceRequest;
  }
}

/**
 * One response for expired, consumed, locked and simply wrong codes.
 *
 * Telling them apart would let an attacker map which codes exist and when a
 * lock lifts.
 */
function invalidCodeException() {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code: 'PHONE_VERIFICATION_INVALID',
    message: 'Doğrulama kodu geçersiz veya süresi dolmuş. Yeni bir kod isteyebilirsiniz.',
  });
}

/** No number on the account, so no code can be sent — the screen shows no button for this. */
function accountPhoneMissingException() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'ACCOUNT_PHONE_MISSING',
    message: 'Hesabınızda kayıtlı bir telefon numarası yok.',
  });
}

/** The account's number is already proven; there is nothing left to do. */
function accountAlreadyVerifiedException() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'ACCOUNT_PHONE_ALREADY_VERIFIED',
    message: 'Hesap telefonunuz zaten doğrulanmış.',
  });
}

/**
 * Which answer the code is, if it is one at all.
 *
 * The sent code is always checked first and always checked — the bcrypt
 * comparison runs whether or not a test bypass could apply, so the timing of
 * a refusal does not say whether this number is on a list. The test code is a
 * second acceptable answer only while every clause of the bypass contract
 * holds (see phone-verification-test-bypass.config.ts); for every other
 * number, environment and moment it is simply a wrong code, and it costs an
 * attempt like any other.
 *
 * Nothing about the flow is relaxed on the way here: the caller has already
 * required a live, unexpired, unlocked row, which is the same row a real code
 * would have needed.
 */
async function acceptedCode(
  code: string,
  codeHash: string,
  normalizedPhone: string,
  now: Date,
): Promise<'sent-code' | 'test-bypass' | null> {
  if (await bcrypt.compare(code, codeHash)) {
    return 'sent-code';
  }

  return isPhoneVerificationTestBypassMatch(normalizedPhone, code, now) ? 'test-bypass' : null;
}

/** Whether two spellings name one number; an unparseable one names none. */
function sameNumber(stored: string, normalized: string): boolean {
  try {
    return normalizePhoneNumber(stored) === normalized;
  } catch {
    return false;
  }
}

function generateCode(): string {
  // randomInt is CSPRNG-backed; Math.random is not acceptable for a credential.
  const max = 10 ** OTP_CODE_LENGTH;
  return String(randomInt(0, max)).padStart(OTP_CODE_LENGTH, '0');
}

function normalizeCode(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalidCodeException();
  }

  const digits = value.trim();
  if (!new RegExp(`^\\d{${OTP_CODE_LENGTH}}$`).test(digits)) {
    throw invalidCodeException();
  }

  return digits;
}
