import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { maskPhone } from '../notifications/mask';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
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
export class PhoneVerificationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationDispatcher) private readonly notifications: NotificationDispatcher,
  ) {}

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

        return { ok: true as const, verifiedAt: now };
      },
      { label: 'phoneVerification.verifyCode' },
    );

    if (!outcome.ok) {
      throw invalidCodeException();
    }

    void meta;
    return { status: 'verified' as const, phoneVerifiedAt: outcome.verifiedAt };
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
      await tx.phoneVerification.updateMany({
        where: { requestId: null, normalizedPhone, consumedAt: null },
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
          where: { requestId: null, normalizedPhone, consumedAt: null },
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
