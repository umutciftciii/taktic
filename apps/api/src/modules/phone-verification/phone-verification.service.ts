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
import { UserRole } from '@prisma/client';
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

        const matches = await bcrypt.compare(code, candidate.codeHash);

        if (!matches) {
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
          data: { consumedAt: now },
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
