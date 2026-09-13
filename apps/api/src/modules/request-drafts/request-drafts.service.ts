import { ConflictException, HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, RequestDraftFormType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RequestIdentityService } from '../auth/request-identity.service';
import { RequestDraftPayload } from './dto/create-request-draft.dto';
import { generateDraftToken, hashDraftToken } from './request-draft.cookie';
import {
  REQUEST_DRAFT_MAX_ACTIVE, REQUEST_DRAFT_MAX_PAYLOAD_BYTES, REQUEST_DRAFT_SWEEP_BATCH,
  REQUEST_DRAFT_SWEEP_INTERVAL_MS, REQUEST_DRAFT_TTL_MS,
} from './request-drafts.constants';

export type DraftKey = { formType: RequestDraftFormType; categorySlug: string; cardId: string | null };

export type CurrentDraft =
  | { kind: 'none' }
  | { kind: 'payload'; payload: RequestDraftPayload }
  | { kind: 'wrong-account' };

function sameKey(row: DraftKey, key: DraftKey): boolean {
  return row.formType === key.formType && row.categorySlug === key.categorySlug && (row.cardId ?? null) === (key.cardId ?? null);
}

function liveWhere(now: Date) {
  return { consumedAt: null, expiresAt: { gt: now } };
}

@Injectable()
export class RequestDraftsService {
  private readonly logger = new Logger(RequestDraftsService.name);
  /** Overridable in tests; the env-derived default otherwise. */
  maxActive = REQUEST_DRAFT_MAX_ACTIVE;
  private lastSweepAt = 0;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestIdentityService) private readonly identity: RequestIdentityService,
  ) {}

  async create(
    input: { key: DraftKey; payload: RequestDraftPayload; identity: { phone: string; email: string }; replace: boolean },
    existingToken: string | null,
  ): Promise<{ token: string; expiresAt: Date }> {
    if (Buffer.byteLength(JSON.stringify(input.payload), 'utf8') > REQUEST_DRAFT_MAX_PAYLOAD_BYTES) {
      throw new HttpException({ statusCode: 400, error: 'Bad Request', code: 'DRAFT_TOO_LARGE', message: 'Taslak çok büyük.' }, HttpStatus.BAD_REQUEST);
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + REQUEST_DRAFT_TTL_MS);

    const classified = await this.identity.classifyNow(input.identity);
    if (classified.status === 'identity-conflict' || classified.status === 'unavailable') {
      throw new ConflictException({ statusCode: 409, error: 'Conflict', code: 'DRAFT_NOT_CONTINUABLE', message: 'Bu iletişim bilgileriyle taslak kaydedilemez.' });
    }
    const expectedUserId = classified.matchedCustomerId;

    const existing = existingToken
      ? await this.prisma.requestDraft.findFirst({ where: { tokenHash: hashDraftToken(existingToken), ...liveWhere(now) } })
      : null;

    if (existing && sameKey(existing, input.key)) {
      await this.prisma.requestDraft.update({
        where: { id: existing.id },
        data: { payload: input.payload as Prisma.InputJsonValue, expectedUserId, expiresAt },
      });
      return { token: existingToken as string, expiresAt };
    }

    if (existing && !input.replace) {
      throw new ConflictException({ statusCode: 409, error: 'Conflict', code: 'DRAFT_EXISTS', message: 'Bu tarayıcıda başka bir talep taslağı var.' });
    }

    if (!existing) {
      const active = await this.prisma.requestDraft.count({ where: liveWhere(now) });
      if (active >= this.maxActive) {
        throw new HttpException(
          { statusCode: 503, error: 'Service Unavailable', code: 'DRAFT_STORAGE_BUSY', message: 'Taslak şu anda kaydedilemedi. Birkaç dakika sonra tekrar deneyin.' },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
    }

    const token = generateDraftToken();
    await this.prisma.$transaction(async (tx) => {
      if (existing) {
        // Explicit replace: the old row goes in the same transaction the new one
        // arrives in, so no browser ever references two rows or none.
        await tx.requestDraft.delete({ where: { id: existing.id } });
      }
      await tx.requestDraft.create({
        data: {
          tokenHash: hashDraftToken(token),
          formType: input.key.formType,
          categorySlug: input.key.categorySlug,
          cardId: input.key.cardId,
          payload: input.payload as Prisma.InputJsonValue,
          expectedUserId,
          expiresAt,
        },
      });
    });

    setImmediate(() => void this.sweepExpired().catch((error) => this.logger.warn(`draft sweep failed: ${String(error)}`)));
    return { token, expiresAt };
  }

  async current(token: string | null, key: DraftKey, sessionUserId: string | null): Promise<CurrentDraft> {
    if (!token) return { kind: 'none' };
    const row = await this.prisma.requestDraft.findFirst({ where: { tokenHash: hashDraftToken(token), ...liveWhere(new Date()) } });
    if (!row || !sameKey(row, key)) return { kind: 'none' };

    if (row.expectedUserId === null) {
      // Anonymous drafts stay anonymous: nobody is bound here.
      return { kind: 'payload', payload: row.payload as RequestDraftPayload };
    }
    if (!sessionUserId) return { kind: 'none' };
    if (sessionUserId !== row.expectedUserId) {
      // The row is left exactly as it is: the right account can still open it.
      return { kind: 'wrong-account' };
    }
    if (row.userId !== sessionUserId) {
      await this.prisma.requestDraft.update({ where: { id: row.id }, data: { userId: sessionUserId } });
    }
    return { kind: 'payload', payload: row.payload as RequestDraftPayload };
  }

  async discard(token: string | null): Promise<void> {
    if (!token) return;
    await this.prisma.requestDraft.deleteMany({ where: { tokenHash: hashDraftToken(token) } });
  }

  /**
   * Marks the draft the browser carried as used by the request just created,
   * inside that request's own transaction. A draft protected for another
   * account is left untouched and never blocks the request.
   */
  async consumeInTransaction(tx: Prisma.TransactionClient, token: string | null, key: DraftKey, customerId: string | null): Promise<void> {
    if (!token) return;
    const now = new Date();
    const row = await tx.requestDraft.findFirst({ where: { tokenHash: hashDraftToken(token), ...liveWhere(now) } });
    if (!row || !sameKey(row, key)) return;
    if (row.expectedUserId !== null && row.expectedUserId !== customerId) return;
    await tx.requestDraft.update({ where: { id: row.id }, data: { consumedAt: now, userId: customerId } });
  }

  /**
   * Bounded, throttled physical cleanup. Expired rows are already logically
   * dead; this only reclaims the storage.
   *
   * The cooldown is set synchronously, before the first `await` — single-
   * flight: two overlapping callers (an opportunistic call from create() and
   * a concurrent one from another request) must not both pass the check and
   * both run the query, even though the very first ever call finds nothing to
   * delete. Locking the window on an empty result is deliberate, not a
   * missed optimisation.
   */
  async sweepExpired(): Promise<number> {
    const now = Date.now();
    if (now - this.lastSweepAt < REQUEST_DRAFT_SWEEP_INTERVAL_MS) return 0;
    this.lastSweepAt = now;
    const victims = await this.prisma.requestDraft.findMany({
      where: { expiresAt: { lt: new Date(now) } },
      select: { id: true },
      orderBy: { expiresAt: 'asc' },
      take: REQUEST_DRAFT_SWEEP_BATCH,
    });
    if (victims.length === 0) return 0;
    const result = await this.prisma.requestDraft.deleteMany({ where: { id: { in: victims.map((v) => v.id) } } });
    return result.count;
  }
}
