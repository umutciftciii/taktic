import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { SESSION_TTL_DAYS } from './auth.constants';

export type SessionMeta = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

export function sessionExpiry() {
  return new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Issues a login session. Shared by password login, registration and customer
 * activation so all three produce identical session semantics.
 */
export async function createSessionForUser(
  client: Pick<Prisma.TransactionClient, 'session' | 'user'>,
  userId: string,
  meta: SessionMeta,
) {
  const expiresAt = sessionExpiry();
  const session = await client.session.create({
    data: {
      id: randomBytes(32).toString('hex'),
      userId,
      expiresAt,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    },
  });

  await client.user.update({
    where: { id: userId },
    data: { lastLoginAt: new Date() },
  });

  return { sessionId: session.id, expiresAt };
}
