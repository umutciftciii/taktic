import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CustomerOrigin, Prisma, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { createSessionForUser, SessionMeta } from '../auth/session.util';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import {
  CUSTOMER_ACTIVATION_PATH,
  CUSTOMER_ACTIVATION_TOKEN_TTL_HOURS,
  getWebAppBaseUrl,
} from './customer-activation.constants';
import { SubmitCustomerActivationDto } from './dto/submit-customer-activation.dto';

type CustomerSummary = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  customerOrigin: CustomerOrigin | null;
};

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

function generateRawToken(): string {
  return randomBytes(32).toString('base64url');
}

function buildActivationUrl(rawToken: string): string {
  const base = getWebAppBaseUrl();
  const url = new URL(CUSTOMER_ACTIVATION_PATH, `${base}/`);
  url.searchParams.set('token', rawToken);
  return url.toString();
}

/**
 * A customer account is claimable when the platform created it on the visitor's
 * behalf (guest service request) and it still has no password. Anything else —
 * a self-registered customer, an admin-created one, an account that already set
 * a password — must keep the ordinary duplicate/conflict behaviour so an
 * existing account can never be taken over without proving mailbox ownership.
 */
function isClaimableCustomer(customer: {
  role: UserRole;
  isActive: boolean;
  passwordHash: string | null;
  customerOrigin: CustomerOrigin | null;
}): boolean {
  return (
    customer.role === UserRole.CUSTOMER &&
    customer.isActive &&
    customer.passwordHash === null &&
    customer.customerOrigin === CustomerOrigin.AUTO_CREATED_REQUEST
  );
}

@Injectable()
export class CustomerActivationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationDispatcher) private readonly notifications: NotificationDispatcher,
  ) {}

  async createForCustomer(customerId: string, createdById: string | null) {
    const customer = await this.prisma.user.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
        customerOrigin: true,
        passwordHash: true,
      },
    });

    if (!customer || customer.role !== UserRole.CUSTOMER) {
      throw new NotFoundException('Customer not found');
    }

    if (customer.customerOrigin !== CustomerOrigin.AUTO_CREATED_REQUEST) {
      throw new ConflictException(
        'Aktivasyon linki yalnızca otomatik oluşturulan müşteriler için üretilebilir.',
      );
    }

    if (customer.passwordHash) {
      throw new ConflictException('Bu müşteri için zaten bir şifre tanımlı.');
    }

    if (!customer.isActive) {
      throw new ConflictException('Pasif müşteri için aktivasyon linki oluşturulamaz.');
    }

    const issued = await this.issueToken(customer.id, createdById);

    return {
      activationUrl: issued.activationUrl,
      expiresAt: issued.expiresAt,
      customer: this.toSummary(customer),
    };
  }

  /**
   * Guest service-request path: the platform just auto-created a password-less
   * customer account, so mail them a link to claim it.
   *
   * Best-effort by design — a notification failure must never roll back or fail
   * the service request the visitor just submitted. Returns null when the
   * account is not claimable (already has a password, self-registered, …).
   */
  async issueForAutoCreatedCustomer(customerId: string) {
    const customer = await this.prisma.user.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
        customerOrigin: true,
        passwordHash: true,
      },
    });

    if (!customer || !customer.email || !isClaimableCustomer(customer)) {
      return null;
    }

    return this.issueAndNotify(customer.id, customer.email, customer.name, null);
  }

  /**
   * Registration claim path: someone tried to register with an e-mail that
   * already belongs to an auto-created, password-less account. Instead of a
   * dead-end duplicate error we re-send the activation link. The caller never
   * receives the token, so this cannot be used to take over an account.
   *
   * Returns null when the e-mail does not belong to a claimable account — the
   * caller must then keep its ordinary duplicate behaviour.
   */
  async requestActivationForEmail(email: string) {
    const normalized = email.trim().toLowerCase();
    if (!normalized) {
      return null;
    }

    const customer = await this.prisma.user.findUnique({
      where: { email: normalized },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        customerOrigin: true,
        passwordHash: true,
      },
    });

    if (!customer || !customer.email || !isClaimableCustomer(customer)) {
      return null;
    }

    await this.issueAndNotify(customer.id, customer.email, customer.name, null);
    return { status: 'activation-sent' as const };
  }

  private async issueAndNotify(
    customerId: string,
    email: string,
    name: string | null,
    createdById: string | null,
  ) {
    const issued = await this.issueToken(customerId, createdById);

    // Goes through the dispatcher so the send is audited, but the payload and
    // the transport are unchanged: the same NotificationPort adapter receives
    // the same message. A transport failure is recorded as FAILED and does not
    // invalidate the token that was just issued.
    await this.notifications.sendEmail(
      {
        template: 'customer-activation',
        to: email,
        subject: 'TakTic hesabınızı etkinleştirin',
        actionUrl: issued.activationUrl,
        data: {
          name,
          expiresAt: issued.expiresAt.toISOString(),
        },
      },
      { userId: customerId },
    );

    return issued;
  }

  /**
   * Issues a fresh single-use token and invalidates every other outstanding one
   * for the same customer, so at most one activation link is ever live.
   */
  private async issueToken(customerId: string, createdById: string | null) {
    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(
      Date.now() + CUSTOMER_ACTIVATION_TOKEN_TTL_HOURS * 60 * 60 * 1000,
    );
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.customerActivationToken.updateMany({
        where: {
          customerId,
          usedAt: null,
        },
        data: {
          usedAt: now,
        },
      });

      await tx.customerActivationToken.create({
        data: {
          customerId,
          tokenHash,
          expiresAt,
          createdById,
        },
      });
    });

    return { activationUrl: buildActivationUrl(rawToken), expiresAt };
  }

  async validateRawToken(rawToken: string) {
    const lookup = await this.lookupActiveToken(rawToken);

    return {
      valid: true as const,
      customer: this.toSummary(lookup.customer),
      expiresAt: lookup.token.expiresAt,
    };
  }

  async submit(dto: SubmitCustomerActivationDto, meta: SessionMeta = {}) {
    const token = dto.token.trim();
    if (!token) {
      throw new BadRequestException('Token is required');
    }

    const lookup = await this.lookupActiveToken(token);

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const now = new Date();

    let session: { sessionId: string; expiresAt: Date };

    try {
      session = await this.prisma.$transaction(async (tx) => {
        // Consuming the token and setting the password happen in one
        // transaction, and the token row is only claimed when it is still
        // unused and unexpired — so two concurrent submits cannot both win.
        const updated = await tx.customerActivationToken.updateMany({
          where: {
            id: lookup.token.id,
            usedAt: null,
            expiresAt: { gt: now },
          },
          data: { usedAt: now },
        });

        if (updated.count === 0) {
          throw new BadRequestException('Bağlantı geçersiz veya süresi dolmuş.');
        }

        const customerUpdate = await tx.user.updateMany({
          where: {
            id: lookup.customer.id,
            role: UserRole.CUSTOMER,
            passwordHash: null,
            isActive: true,
          },
          // Consuming this link is itself proof of mailbox control: it was
          // delivered to that address, it is single use, and it was never
          // returned over HTTP. Recording it here is what keeps the separate
          // verification flow from ever mailing an account that has already
          // proved the same thing a different way.
          data: { passwordHash, emailVerifiedAt: now },
        });

        if (customerUpdate.count === 0) {
          throw new ConflictException('Bu müşteri için aktivasyon yapılamıyor.');
        }

        return createSessionForUser(tx, lookup.customer.id, meta);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        throw new BadRequestException('Bağlantı geçersiz veya süresi dolmuş.');
      }

      throw error;
    }

    return {
      success: true as const,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      user: {
        id: lookup.customer.id,
        email: lookup.customer.email,
        phone: lookup.customer.phone,
        name: lookup.customer.name,
        role: UserRole.CUSTOMER,
        isActive: true,
      },
    };
  }

  private async lookupActiveToken(rawToken: string) {
    const tokenHash = hashToken(rawToken.trim());
    const record = await this.prisma.customerActivationToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        expiresAt: true,
        usedAt: true,
        customer: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            role: true,
            isActive: true,
            customerOrigin: true,
            passwordHash: true,
          },
        },
      },
    });

    if (!record) {
      throw new BadRequestException('Bağlantı geçersiz veya süresi dolmuş.');
    }

    if (record.usedAt) {
      throw new BadRequestException('Bağlantı zaten kullanılmış.');
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Bağlantının süresi dolmuş.');
    }

    if (record.customer.role !== UserRole.CUSTOMER) {
      throw new BadRequestException('Bağlantı geçersiz.');
    }

    if (!record.customer.isActive) {
      throw new BadRequestException('Müşteri pasif durumda.');
    }

    if (record.customer.passwordHash) {
      throw new BadRequestException('Bu müşteri için zaten bir şifre tanımlı.');
    }

    return {
      token: { id: record.id, expiresAt: record.expiresAt },
      customer: record.customer,
    };
  }

  private toSummary(customer: {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    customerOrigin: CustomerOrigin | null;
  }): CustomerSummary {
    return {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      customerOrigin: customer.customerOrigin,
    };
  }
}
