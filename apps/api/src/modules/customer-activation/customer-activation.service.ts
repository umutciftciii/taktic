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

@Injectable()
export class CustomerActivationService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

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

    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(
      Date.now() + CUSTOMER_ACTIVATION_TOKEN_TTL_HOURS * 60 * 60 * 1000,
    );
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.customerActivationToken.updateMany({
        where: {
          customerId: customer.id,
          usedAt: null,
        },
        data: {
          usedAt: now,
        },
      });

      await tx.customerActivationToken.create({
        data: {
          customerId: customer.id,
          tokenHash,
          expiresAt,
          createdById,
        },
      });
    });

    return {
      activationUrl: buildActivationUrl(rawToken),
      expiresAt,
      customer: this.toSummary(customer),
    };
  }

  async validateRawToken(rawToken: string) {
    const lookup = await this.lookupActiveToken(rawToken);

    return {
      valid: true as const,
      customer: this.toSummary(lookup.customer),
      expiresAt: lookup.token.expiresAt,
    };
  }

  async submit(dto: SubmitCustomerActivationDto) {
    const token = dto.token.trim();
    if (!token) {
      throw new BadRequestException('Token is required');
    }

    const lookup = await this.lookupActiveToken(token);

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const now = new Date();

    try {
      await this.prisma.$transaction(async (tx) => {
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
          data: { passwordHash },
        });

        if (customerUpdate.count === 0) {
          throw new ConflictException('Bu müşteri için aktivasyon yapılamıyor.');
        }
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        throw new BadRequestException('Bağlantı geçersiz veya süresi dolmuş.');
      }

      throw error;
    }

    return { success: true as const };
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
