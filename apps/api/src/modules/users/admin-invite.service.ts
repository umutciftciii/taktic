import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ADMIN_INVITE_PATH,
  ADMIN_INVITE_TOKEN_TTL_HOURS,
  getAdminAppBaseUrl,
} from './admin-invite.constants';
import { SubmitAdminInviteDto } from './dto/submit-admin-invite.dto';

type AdminUserSummary = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  role: UserRole;
};

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

function generateRawToken(): string {
  return randomBytes(32).toString('base64url');
}

function buildInviteUrl(rawToken: string): string {
  const base = getAdminAppBaseUrl();
  const url = new URL(ADMIN_INVITE_PATH, `${base}/`);
  url.searchParams.set('token', rawToken);
  return url.toString();
}

type InviteCreationResult = {
  inviteUrl: string;
  expiresAt: Date;
};

@Injectable()
export class AdminInviteService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async createForUser(
    tx: Prisma.TransactionClient | PrismaService,
    userId: string,
    createdById: string | null,
  ): Promise<InviteCreationResult> {
    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(
      Date.now() + ADMIN_INVITE_TOKEN_TTL_HOURS * 60 * 60 * 1000,
    );
    const now = new Date();

    await tx.adminInviteToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: now },
    });

    await tx.adminInviteToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt,
        createdById,
      },
    });

    return { inviteUrl: buildInviteUrl(rawToken), expiresAt };
  }

  async regenerateForUser(userId: string, createdById: string | null) {
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
        passwordHash: true,
      },
    });

    if (!target || target.role !== UserRole.SUPER_ADMIN) {
      throw new NotFoundException('User not found');
    }

    if (!target.isActive) {
      throw new ConflictException(
        'Pasif admin kullanıcısı için davet linki oluşturulamaz.',
      );
    }

    if (target.passwordHash) {
      throw new ConflictException(
        'Bu admin kullanıcısı için zaten şifre tanımlı.',
      );
    }

    const result = await this.createForUser(this.prisma, target.id, createdById);

    const user: AdminUserSummary = {
      id: target.id,
      name: target.name,
      email: target.email,
      phone: target.phone,
      role: target.role,
    };

    return {
      inviteUrl: result.inviteUrl,
      expiresAt: result.expiresAt,
      user,
    };
  }

  async validateRawToken(rawToken: string) {
    const lookup = await this.lookupActiveToken(rawToken);

    return {
      valid: true as const,
      user: {
        name: lookup.user.name,
        email: lookup.user.email,
      },
      expiresAt: lookup.token.expiresAt,
    };
  }

  async submit(dto: SubmitAdminInviteDto) {
    const token = dto.token.trim();
    if (!token) {
      throw new BadRequestException('Token is required');
    }

    const lookup = await this.lookupActiveToken(token);

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const now = new Date();

    try {
      await this.prisma.$transaction(async (tx) => {
        const updated = await tx.adminInviteToken.updateMany({
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

        const userUpdate = await tx.user.updateMany({
          where: {
            id: lookup.user.id,
            role: UserRole.SUPER_ADMIN,
            passwordHash: null,
            isActive: true,
          },
          data: { passwordHash },
        });

        if (userUpdate.count === 0) {
          throw new ConflictException(
            'Bu admin kullanıcısı için şifre belirlenemiyor.',
          );
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
    const record = await this.prisma.adminInviteToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        expiresAt: true,
        usedAt: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            role: true,
            isActive: true,
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

    if (record.user.role !== UserRole.SUPER_ADMIN) {
      throw new BadRequestException('Bağlantı geçersiz.');
    }

    if (!record.user.isActive) {
      throw new BadRequestException('Admin kullanıcısı pasif durumda.');
    }

    if (record.user.passwordHash) {
      throw new BadRequestException(
        'Bu admin kullanıcısı için zaten şifre tanımlı.',
      );
    }

    return {
      token: { id: record.id, expiresAt: record.expiresAt },
      user: record.user,
    };
  }
}
