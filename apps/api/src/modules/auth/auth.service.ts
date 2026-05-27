import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { SESSION_TTL_DAYS } from './auth.constants';
import { AuthUser } from './auth.types';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

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

    const expiresAt = sessionExpiry();
    const session = await this.prisma.session.create({
      data: {
        id: randomBytes(32).toString('hex'),
        userId: user.id,
        expiresAt,
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      },
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      sessionId: session.id,
      expiresAt,
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
}

function sessionExpiry() {
  return new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
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
