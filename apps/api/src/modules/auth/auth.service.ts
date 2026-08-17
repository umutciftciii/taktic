import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { CustomerOrigin, Prisma, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from './auth.types';
import { EmailAlreadyRegisteredException } from './auth.errors';
import { createSessionForUser } from './session.util';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

@Injectable()
export class AuthService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  registerCustomer(dto: RegisterDto, meta: { ipAddress?: string | null; userAgent?: string | null }) {
    return this.register(dto, UserRole.CUSTOMER, meta);
  }

  registerProvider(dto: RegisterDto, meta: { ipAddress?: string | null; userAgent?: string | null }) {
    return this.register(dto, UserRole.PROVIDER, meta);
  }

  async login(dto: LoginDto, meta: { ipAddress?: string | null; userAgent?: string | null }) {
    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        phone: true,
        name: true,
        role: true,
        isActive: true,
        passwordHash: true,
      },
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!user.isActive) {
      throw new ForbiddenException('User is inactive');
    }

    const passwordMatches = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const session = await createSessionForUser(this.prisma, user.id, meta);

    return {
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      user: toSafeUser(user),
    };
  }

  async logout(sessionId: string | null) {
    if (sessionId) {
      await this.prisma.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
  }

  async getUserForSession(sessionId: string | null): Promise<AuthUser | null> {
    if (!sessionId) {
      return null;
    }

    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            phone: true,
            name: true,
            role: true,
            isActive: true,
          },
        },
      },
    });

    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
      return null;
    }

    if (!session.user.isActive) {
      throw new ForbiddenException('User is inactive');
    }

    await this.prisma.session.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date() },
    });

    return session.user;
  }

  private async register(
    dto: RegisterDto,
    role: UserRole,
    meta: { ipAddress?: string | null; userAgent?: string | null },
  ) {
    const name = normalizeRequiredString(dto.name, 'Name');
    const email = dto.email.trim().toLowerCase();
    const phone = normalizeOptionalPhone(dto.phone);
    const passwordHash = await bcrypt.hash(dto.password, 12);

    try {
      const user = await this.prisma.user.create({
        data: {
          name,
          email,
          phone,
          role,
          isActive: true,
          passwordHash,
          customerOrigin: role === UserRole.CUSTOMER ? CustomerOrigin.REGISTERED : null,
        },
        select: {
          id: true,
          email: true,
          phone: true,
          name: true,
          role: true,
          isActive: true,
        },
      });

      const session = await createSessionForUser(this.prisma, user.id, meta);

      return {
        sessionId: session.sessionId,
        expiresAt: session.expiresAt,
        user,
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target = Array.isArray(error.meta?.target)
          ? error.meta.target.join(',')
          : String(error.meta?.target ?? '');
        if (target.includes('phone')) {
          throw new ConflictException('Phone already registered');
        }

        throw new EmailAlreadyRegisteredException(email);
      }

      throw error;
    }
  }
}

function toSafeUser(user: {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  role: AuthUser['role'];
  isActive: boolean;
}) {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
  };
}

function normalizeRequiredString(value: unknown, fieldName: string) {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${fieldName} is required`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new BadRequestException(`${fieldName} cannot be empty`);
  }

  return trimmed;
}

function normalizeOptionalPhone(value: string | null | undefined) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new BadRequestException('Phone must be a string');
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new BadRequestException('Phone cannot be empty when provided');
  }

  return trimmed;
}
