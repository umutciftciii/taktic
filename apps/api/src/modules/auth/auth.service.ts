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
import { sessionTouchIntervalSeconds } from './auth.constants';
import {
  createSessionForUser,
  effectiveExpiry,
  toSessionStatus,
  type SessionStatus,
} from './session.util';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

/**
 * What the controller knows about the caller when a session is issued.
 *
 * `currentSessionId` is the session the request arrived with, if any. It exists
 * so the login path can revoke it — see the session-fixation note in `login`.
 */
type SessionMeta = {
  ipAddress?: string | null;
  userAgent?: string | null;
  currentSessionId?: string | null;
};

@Injectable()
export class AuthService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  registerCustomer(dto: RegisterDto, meta: SessionMeta) {
    return this.register(dto, UserRole.CUSTOMER, meta);
  }

  registerProvider(dto: RegisterDto, meta: SessionMeta) {
    return this.register(dto, UserRole.PROVIDER, meta);
  }

  async login(dto: LoginDto, meta: SessionMeta) {
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

    // Session fixation: the caller arrives with a brand-new session id, and any
    // session id they were carrying before they proved who they are is revoked.
    // A cookie planted on the browser beforehand is therefore worthless — it
    // names a session that is dead by the time the password was accepted.
    await this.revokeSession(meta.currentSessionId ?? null);

    const session = await createSessionForUser(this.prisma, user.id, meta, {
      rememberMe: dto.rememberMe === true,
    });

    return {
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      rememberMe: session.rememberMe,
      user: toSafeUser(user),
    };
  }

  async logout(sessionId: string | null) {
    await this.revokeSession(sessionId);
  }

  /** Marks one session revoked. Idempotent, and safe to call with null. */
  async revokeSession(sessionId: string | null) {
    if (!sessionId) {
      return;
    }

    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async getUserForSession(sessionId: string | null): Promise<AuthUser | null> {
    const resolved = await this.resolveSession(sessionId, { touch: true });
    return resolved?.user ?? null;
  }

  /**
   * The session's remaining life, without spending any of it.
   *
   * Deliberately does NOT touch `lastSeenAt`. This is what a client polls to
   * know when to warn somebody, and a read that slid the idle window would make
   * an open tab immortal — the warning would never be reached, and an
   * unattended browser would stay signed in forever.
   */
  async getSessionStatus(sessionId: string | null): Promise<SessionStatus | null> {
    const resolved = await this.resolveSession(sessionId, { touch: false });
    return resolved ? toSessionStatus(resolved.session) : null;
  }

  /**
   * Records activity and returns the extended window.
   *
   * The one place a client may slide the idle clock on purpose — "keep me
   * signed in", and the throttled heartbeat behind real interaction. It can
   * only extend the idle window: `expiresAt` is never rewritten, so a session
   * cannot renew itself past its absolute lifetime however often this is
   * called.
   */
  async touchSession(sessionId: string | null): Promise<SessionStatus | null> {
    const resolved = await this.resolveSession(sessionId, { touch: true, force: true });
    if (!resolved) {
      return null;
    }

    return toSessionStatus({ ...resolved.session, lastSeenAt: resolved.lastSeenAt });
  }

  /**
   * Validates a session against the database and, optionally, records activity.
   *
   * Four independent refusals, checked in order and none of them extending
   * another: unknown, revoked, past its absolute expiry, idle for longer than
   * the inactivity window. Every one of them is a fact in the row — no client
   * timestamp, header or query parameter takes part in the decision, so a
   * browser whose clock has been moved cannot change the answer.
   */
  private async resolveSession(
    sessionId: string | null,
    options: { touch: boolean; force?: boolean },
  ) {
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

    if (!session || session.revokedAt) {
      return null;
    }

    const now = Date.now();

    // Absolute lifetime, fixed at creation and never moved forward here.
    if (session.expiresAt.getTime() <= now) {
      return null;
    }

    // Idle timeout, under this session's own policy. `Session.rememberMe` is
    // what selects it, so a remembered session is never measured against the
    // ordinary window and an ordinary one is never given the remembered one.
    // `lastSeenAt` has a database default, so it is always set; falling back to
    // createdAt costs nothing and cannot read as "never idle".
    const lastSeenAt = session.lastSeenAt ?? session.createdAt;
    if (
      effectiveExpiry({
        expiresAt: session.expiresAt,
        lastSeenAt,
        rememberMe: session.rememberMe,
      }).getTime() <= now
    ) {
      return null;
    }

    if (!session.user.isActive) {
      throw new ForbiddenException('User is inactive');
    }

    let effectiveLastSeenAt = lastSeenAt;

    if (options.touch) {
      // Bounded, so an active user does not turn one row into a write hot spot.
      // An explicit "keep me signed in" bypasses the bound: the whole point of
      // that click is to move the mark now.
      const since = now - lastSeenAt.getTime();
      if (options.force || since > sessionTouchIntervalSeconds() * 1000) {
        effectiveLastSeenAt = new Date();
        await this.prisma.session.update({
          where: { id: session.id },
          data: { lastSeenAt: effectiveLastSeenAt },
        });
      }
    }

    return {
      user: session.user,
      lastSeenAt: effectiveLastSeenAt,
      session: {
        expiresAt: session.expiresAt,
        lastSeenAt: effectiveLastSeenAt,
        rememberMe: session.rememberMe,
      },
    };
  }

  private async register(dto: RegisterDto, role: UserRole, meta: SessionMeta) {
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

      await this.revokeSession(meta.currentSessionId ?? null);

      // Registration never asks to be remembered: the checkbox lives on the
      // sign-in screens, and somebody creating an account has not been offered
      // the choice. They get an ordinary session.
      const session = await createSessionForUser(this.prisma, user.id, meta);

      return {
        sessionId: session.sessionId,
        expiresAt: session.expiresAt,
        rememberMe: session.rememberMe,
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
