import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { SensitiveDataSubject, UserRole } from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import {
  BUSINESS_REGISTRATION_ERROR,
  maskLegacyTaxNumber,
  requireValidBusinessRegistration,
} from './business-registration.rules';
import {
  businessRegistrationMaskedSelect,
  registrationView,
  writeBusinessRegistration,
  type BusinessRegistrationView,
} from './business-registration.writer';

/** The fields a raw read discloses — written to the access log by name, never by value. */
export const RAW_REGISTRATION_FIELDS = ['ProviderBusinessRegistration.numberCanonical', 'ProviderProfile.taxNumber'] as const;

export type OwnBusinessRegistration = {
  registration: BusinessRegistrationView;
  /** The unverified free text from before PR-C, masked. */
  legacy: { taxType: string | null; taxNumberMasked: string | null };
};

/**
 * The provider's own registration surface and the one audited raw read
 * (CMP-006 PR-C). Every other response gets the registration through the
 * masked relation select; the raw number leaves the API only from `readRaw`,
 * and only after its access-log row is written in the same transaction.
 */
@Injectable()
export class BusinessRegistrationService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async getOwn(user: AuthUser): Promise<OwnBusinessRegistration> {
    const provider = await this.ownProvider(user);
    return this.ownView(provider.id);
  }

  /**
   * The provider replacing their own declaration. A type is required here —
   * an owner answering the question cannot answer it with nothing; "I declare
   * none" is NONE_DECLARED.
   */
  async updateOwn(user: AuthUser, input: { type?: string | null; number?: string | null }): Promise<OwnBusinessRegistration> {
    const declaration = requireValidBusinessRegistration(input.type, input.number);
    if (!declaration) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: BUSINESS_REGISTRATION_ERROR.typeRequired,
        message: 'İşletme kaydı türünü seçin.',
      });
    }
    const provider = await this.ownProvider(user);
    await runSerializable(
      this.prisma,
      (tx) =>
        writeBusinessRegistration(tx, {
          providerId: provider.id,
          declaration,
          actorKind: 'PROVIDER',
          actorUserId: user.id,
        }),
      { label: 'businessRegistration.updateOwn' },
    );
    return this.ownView(provider.id);
  }

  /**
   * The raw registration number and the raw legacy tax number, for an
   * operator holding PROVIDER_REGISTRATION_READ_SENSITIVE (the route checks
   * it). The access-log row is written first, in the same transaction: a read
   * that could not be recorded is a read that does not happen.
   */
  async readRaw(actor: AuthUser, providerId: string) {
    return this.prisma.$transaction(async (tx) => {
      const provider = await tx.providerProfile.findUnique({
        where: { id: providerId },
        select: {
          id: true,
          taxType: true,
          taxNumber: true,
          businessRegistration: { select: { type: true, numberCanonical: true, numberMasked: true, updatedAt: true } },
        },
      });
      if (!provider) {
        throw new NotFoundException('Provider not found');
      }
      await tx.sensitiveDataAccessLog.create({
        data: {
          actorId: actor.id,
          subject: SensitiveDataSubject.PROVIDER_BUSINESS_REGISTRATION,
          providerId,
          fields: [...RAW_REGISTRATION_FIELDS],
        },
      });
      const registration = provider.businessRegistration;
      return {
        providerId,
        registration: {
          ...registrationView(registration),
          number: registration?.numberCanonical ?? null,
        },
        legacy: { taxType: provider.taxType, taxNumber: provider.taxNumber },
      };
    });
  }

  private async ownProvider(user: AuthUser) {
    if (user.role !== UserRole.PROVIDER) {
      throw new NotFoundException('Provider profile not found');
    }
    const provider = await this.prisma.providerProfile.findUnique({ where: { userId: user.id }, select: { id: true } });
    if (!provider) {
      throw new NotFoundException('Provider profile not found');
    }
    return provider;
  }

  private async ownView(providerId: string): Promise<OwnBusinessRegistration> {
    const row = await this.prisma.providerProfile.findUniqueOrThrow({
      where: { id: providerId },
      select: { taxType: true, taxNumber: true, businessRegistration: businessRegistrationMaskedSelect },
    });
    return {
      registration: registrationView(row.businessRegistration),
      legacy: { taxType: row.taxType, taxNumberMasked: maskLegacyTaxNumber(row.taxNumber) },
    };
  }
}
