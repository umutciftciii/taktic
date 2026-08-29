import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  MessageSenderRole,
  Prisma,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import { HttpException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { isContactSharingEnabled } from '../contact-sharing/contact-sharing.config';
import {
  MESSAGE_BODY_MAX_LENGTH,
  MESSAGE_PAGE_DEFAULT_LIMIT,
  MESSAGE_PAGE_MAX_LIMIT,
  MESSAGE_RATE_LIMITED_CODE,
  messageRateLimitMax,
  messageRateLimitWindowSeconds,
} from './messaging.config';
import { decodeMessageCursor, encodeMessageCursor } from './message-cursor';

/**
 * Messaging between a customer and the provider whose offer they accepted.
 *
 * The single rule this service exists to enforce: **a thread is the shadow of a
 * completed match, and authorization is the relation chain, never the id.**
 * Every entry point re-derives the chain from the database —
 *
 *   1. the request is MATCHED and `matchedOfferId` names one offer;
 *   2. that offer is ACCEPTED and belongs to the provider in question;
 *   3. a ContactRevealEvent for exactly that (request, offer) pair exists;
 *   4. the request belongs to a signed-in customer account;
 *   5. the winning provider profile belongs to a platform account;
 *   6. the caller is one of those two accounts.
 *
 * — and refuses otherwise. Knowing or guessing a thread id gets a stranger
 * nothing, because the id is never what is checked. A losing, withdrawn,
 * rejected or still-pending offer never satisfies (2) or (3), so its provider
 * has no thread to find; a different customer never satisfies (6).
 *
 * Condition (3) is what ties messaging to consent. Contact sharing is what
 * opens a channel between two people, and it is recorded once, per match, with
 * the version of the disclosure the customer confirmed. Without that row there
 * is no conversation — and with the feature switched off no row is ever
 * written, so a deployment that has not turned contact sharing on has no
 * messaging either.
 *
 * What this service deliberately never returns: the request's address note or
 * neighbourhood, either party's phone or e-mail, any internal note, any credit
 * or payment fact, and anything at all about a competing offer. A message
 * projection carries a body, who wrote it, when, and nothing else. The details
 * two matched parties may see about each other stay where they already are —
 * behind the matched-contact routes, with their own guards.
 */

/** Why messaging is not available for a match that otherwise looks complete. */
export type ThreadUnavailableReason =
  /** The deployment has contact sharing off, so no reveal is ever recorded. */
  | 'sharing-off'
  /** Matched, but no reveal on file — the match predates contact sharing. */
  | 'not-recorded'
  /** The request was never claimed by an account, so the customer cannot sign in. */
  | 'customer-not-registered'
  /** The winning provider profile belongs to no platform account. */
  | 'provider-not-registered';

/**
 * Raised where the caller *is* one of the two parties but no conversation can
 * exist. A 409 rather than a 404 on purpose: this person is entitled to know
 * why their own match has no message screen, and the reason names nobody.
 */
export class ThreadUnavailableException extends HttpException {
  constructor(readonly reason: ThreadUnavailableReason) {
    super(
      {
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: 'MESSAGE_THREAD_UNAVAILABLE',
        reason,
        message: THREAD_UNAVAILABLE_MESSAGES[reason],
      },
      HttpStatus.CONFLICT,
    );
  }
}

const THREAD_UNAVAILABLE_MESSAGES: Record<ThreadUnavailableReason, string> = {
  'sharing-off': 'İletişim paylaşımı bu kurulumda kapalı olduğu için mesajlaşma açılamıyor.',
  'not-recorded':
    'Bu eşleşme için iletişim paylaşımı kaydı bulunmuyor, bu yüzden mesajlaşma açılamıyor.',
  'customer-not-registered':
    'Bu talep bir hesaba bağlı olmadığı için mesajlaşma açılamıyor.',
  'provider-not-registered':
    'Hizmet verenin işletme profili bir hesaba bağlı olmadığı için mesajlaşma açılamıyor.',
};

/**
 * Everything a thread row needs to carry, and the context the two screens show
 * around it. The category name and the request number are the job's own
 * identity — they are already on every screen either party can reach.
 */
const threadInclude = {
  request: {
    select: {
      id: true,
      requestNumber: true,
      city: true,
      district: true,
      category: { select: { id: true, name: true, slug: true } },
    },
  },
  provider: { select: { id: true, businessName: true } },
  customer: { select: { id: true, name: true } },
} satisfies Prisma.MessageThreadInclude;

type ThreadRow = Prisma.MessageThreadGetPayload<{ include: typeof threadInclude }>;

const messageSelect = {
  id: true,
  threadId: true,
  senderUserId: true,
  senderRole: true,
  body: true,
  createdAt: true,
} satisfies Prisma.MessageSelect;

type MessageRow = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;

/** Which side of a thread the caller is. */
type Participant = {
  role: MessageSenderRole;
  userId: string;
};

@Injectable()
export class MessagingService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Every thread this account may see, most recent conversation first.
   *
   * Scoped by the two participant columns, so the query itself cannot return a
   * thread the caller is not part of — there is no post-filter to forget.
   */
  async listThreads(user: AuthUser) {
    const threads = await this.prisma.messageThread.findMany({
      where: participantWhere(user),
      include: threadInclude,
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
    });

    return Promise.all(
      threads.map(async (thread) => {
        const participant = requireParticipant(thread, user);
        const [lastMessage, unreadCount] = await Promise.all([
          this.prisma.message.findFirst({
            where: { threadId: thread.id },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: messageSelect,
          }),
          this.countUnread(thread, participant),
        ]);

        return {
          ...toThreadSummary(thread, participant),
          unreadCount,
          lastMessage: lastMessage ? toMessage(lastMessage) : null,
        };
      }),
    );
  }

  /** The number the sidebar badge shows. One query per thread, and no bodies. */
  async unreadCount(user: AuthUser) {
    const threads = await this.prisma.messageThread.findMany({
      where: participantWhere(user),
      select: {
        id: true,
        customerUserId: true,
        providerUserId: true,
        customerLastReadAt: true,
        providerLastReadAt: true,
      },
    });

    const counts = await Promise.all(
      threads.map((thread) =>
        this.countUnread(thread, {
          role:
            thread.customerUserId === user.id
              ? MessageSenderRole.CUSTOMER
              : MessageSenderRole.PROVIDER,
          userId: user.id,
        }),
      ),
    );

    return {
      total: counts.reduce((total, count) => total + count, 0),
      threads: counts.filter((count) => count > 0).length,
    };
  }

  /** One thread, with its most recent page of messages. */
  async getThread(threadId: string, user: AuthUser) {
    const { thread, participant } = await this.loadThreadForParticipant(threadId, user);
    const page = await this.readMessages(thread.id, {});
    const unreadCount = await this.countUnread(thread, participant);

    return {
      ...toThreadSummary(thread, participant),
      unreadCount,
      messages: page.messages,
      hasMoreBefore: page.hasMoreBefore,
      olderCursor: page.olderCursor,
      latestCursor: page.latestCursor,
    };
  }

  /**
   * A page of history, or everything written since a cursor.
   *
   * `before` walks backwards through history; `after` is what the open thread
   * polls with. They are mutually exclusive because a request that meant both
   * means neither, and answering it with a guess is how a client ends up
   * silently missing messages.
   */
  async listMessages(
    threadId: string,
    user: AuthUser,
    query: { before?: string; after?: string; limit?: number },
  ) {
    const { thread } = await this.loadThreadForParticipant(threadId, user);

    if (query.before && query.after) {
      throw new BadRequestException('Pass either before or after, not both');
    }

    return this.readMessages(thread.id, query);
  }

  /**
   * Sends one message.
   *
   * Three things have to hold, and they are checked in this order: the caller
   * is a participant, the body is a real message, and this account is not
   * writing faster than the limit allows. The idempotency key is the last line:
   * a resubmitted form carries the key its first attempt did, and the unique
   * index turns the duplicate into the original message rather than a second
   * copy of it.
   */
  async sendMessage(
    threadId: string,
    user: AuthUser,
    input: { body: string; clientToken?: string | null },
  ) {
    const { thread, participant } = await this.loadThreadForParticipant(threadId, user);

    const body = normalizeBody(input.body);
    const clientToken = input.clientToken?.trim() || null;

    await this.assertWithinRateLimit(user.id);

    const now = new Date();

    try {
      const message = await this.prisma.$transaction(async (tx) => {
        const created = await tx.message.create({
          data: {
            threadId: thread.id,
            senderUserId: user.id,
            senderRole: participant.role,
            body,
            clientToken,
            createdAt: now,
          },
          select: messageSelect,
        });

        // The sender has, by definition, read their own message. Moving their
        // mark here is what keeps a thread from reporting its author's own
        // words back to them as unread, and it leaves the counterpart's mark
        // untouched — which is what raises *their* badge.
        await tx.messageThread.update({
          where: { id: thread.id },
          data: {
            lastMessageAt: now,
            ...(participant.role === MessageSenderRole.CUSTOMER
              ? { customerLastReadAt: now }
              : { providerLastReadAt: now }),
          },
        });

        return created;
      });

      return toMessage(message);
    } catch (error) {
      // The same key arrived twice from the same person. Their first message
      // stands and is returned; the second click produced nothing. The sender is
      // part of the lookup for the same reason it is part of the index — the
      // other party may have chosen the same key for a message of their own.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        clientToken
      ) {
        const existing = await this.prisma.message.findFirst({
          where: { threadId: thread.id, senderUserId: user.id, clientToken },
          select: messageSelect,
        });

        if (existing) {
          return toMessage(existing);
        }
      }

      throw error;
    }
  }

  /**
   * Marks everything currently in the thread as read by the caller.
   *
   * The mark is a timestamp on the caller's own side of the thread. The
   * counterpart learns only that their last message has been read — never when
   * it was opened, from where, or on what.
   */
  async markRead(threadId: string, user: AuthUser) {
    const { thread, participant } = await this.loadThreadForParticipant(threadId, user);
    const now = new Date();

    await this.prisma.messageThread.update({
      where: { id: thread.id },
      data:
        participant.role === MessageSenderRole.CUSTOMER
          ? { customerLastReadAt: now }
          : { providerLastReadAt: now },
    });

    return { threadId: thread.id, lastReadAt: now.toISOString(), unreadCount: 0 };
  }

  /**
   * The thread for a match, creating it the first time somebody opens it.
   *
   * Lazy rather than written by the accept cascade, for two reasons: it keeps
   * this feature out of a transaction that is already carrying the match, the
   * credit cascade and the reveal; and it means a match made before messaging
   * existed gets its conversation the moment either party asks for one, with no
   * backfill inventing threads nobody opened.
   *
   * Get-or-create, and the unique indexes on `requestId` and `offerId` are what
   * make two simultaneous first-opens produce one thread rather than two.
   */
  async resolveThreadForRequest(requestId: string, user: AuthUser) {
    const chain = await this.loadMatchChain(requestId, user);

    const existing = await this.prisma.messageThread.findUnique({
      where: { requestId },
      include: threadInclude,
    });

    if (existing) {
      const participant = requireParticipant(existing, user);
      return { ...toThreadSummary(existing, participant), created: false };
    }

    try {
      const created = await this.prisma.messageThread.create({
        data: {
          requestId: chain.requestId,
          offerId: chain.offerId,
          customerUserId: chain.customerUserId,
          providerId: chain.providerId,
          providerUserId: chain.providerUserId,
        },
        include: threadInclude,
      });

      return { ...toThreadSummary(created, requireParticipant(created, user)), created: true };
    } catch (error) {
      // Somebody else opened it first — the other party, or this one in a
      // second tab. Their row is the thread.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.prisma.messageThread.findUnique({
          where: { requestId },
          include: threadInclude,
        });

        if (raced) {
          return { ...toThreadSummary(raced, requireParticipant(raced, user)), created: false };
        }
      }

      throw error;
    }
  }

  /**
   * Loads a thread the caller really is a party to.
   *
   * The participant columns are in the `where`, so a caller who is neither gets
   * the same 404 as one who named a thread that does not exist. That is the
   * whole answer on purpose: "this thread exists, you may not see it" tells a
   * stranger a match happened.
   */
  private async loadThreadForParticipant(threadId: string, user: AuthUser) {
    const thread = await this.prisma.messageThread.findFirst({
      where: { id: threadId, ...participantWhere(user) },
      include: threadInclude,
    });

    if (!thread) {
      throw new NotFoundException('Message thread not found');
    }

    // The thread row is a cache of a chain that was true when it was written.
    // Re-deriving it here is what keeps a conversation from outliving the match
    // it belongs to — a request that was cancelled, or an offer that somehow
    // stopped being the accepted one, closes the thread rather than leaving a
    // channel open on the strength of a stale row.
    await this.assertChainStillHolds(thread);

    return { thread, participant: requireParticipant(thread, user) };
  }

  /**
   * The relation chain, derived from scratch, for a caller who claims to be one
   * of the two parties to a match.
   *
   * Every refusal below is deliberate about which answer it gives. A caller who
   * is not a party gets 404 — they learn nothing. A caller who *is* a party but
   * whose match cannot carry a conversation gets 409 and a reason, because that
   * is their own match and the screen has to be able to say why.
   */
  private async loadMatchChain(requestId: string, user: AuthUser) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        status: true,
        customerId: true,
        matchedOfferId: true,
      },
    });

    if (!request || request.status !== ServiceRequestStatus.MATCHED || !request.matchedOfferId) {
      throw new NotFoundException('Message thread not found');
    }

    const offer = await this.prisma.offer.findUnique({
      where: { id: request.matchedOfferId },
      select: {
        id: true,
        status: true,
        providerId: true,
        provider: { select: { id: true, userId: true } },
      },
    });

    if (!offer || offer.status !== 'ACCEPTED') {
      throw new NotFoundException('Message thread not found');
    }

    const isCustomer =
      user.role === UserRole.CUSTOMER && Boolean(request.customerId) && request.customerId === user.id;
    const isProvider =
      user.role === UserRole.PROVIDER &&
      Boolean(offer.provider.userId) &&
      offer.provider.userId === user.id;

    // Not a party — including a SUPER_ADMIN. Reading message content is not an
    // administrative power in this version; moderation is separate work, and an
    // admin who could open any conversation by default would make that decision
    // silently.
    if (!isCustomer && !isProvider) {
      throw new NotFoundException('Message thread not found');
    }

    // From here on the caller is one of the two people, so the refusals explain
    // themselves.
    if (!isContactSharingEnabled()) {
      throw new ThreadUnavailableException('sharing-off');
    }

    const reveal = await this.prisma.contactRevealEvent.findUnique({
      where: { requestId },
      select: { requestId: true, offerId: true, providerId: true },
    });

    if (!reveal || reveal.offerId !== offer.id || reveal.providerId !== offer.providerId) {
      throw new ThreadUnavailableException('not-recorded');
    }

    if (!request.customerId) {
      throw new ThreadUnavailableException('customer-not-registered');
    }

    if (!offer.provider.userId) {
      throw new ThreadUnavailableException('provider-not-registered');
    }

    return {
      requestId: request.id,
      offerId: offer.id,
      providerId: offer.providerId,
      customerUserId: request.customerId,
      providerUserId: offer.provider.userId,
    };
  }

  /** Re-derives the chain behind an existing thread and refuses a stale one. */
  private async assertChainStillHolds(thread: ThreadRow) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: thread.requestId },
      select: { status: true, matchedOfferId: true, customerId: true },
    });

    const chainHolds =
      request !== null &&
      request.status === ServiceRequestStatus.MATCHED &&
      request.matchedOfferId === thread.offerId &&
      request.customerId === thread.customerUserId;

    if (!chainHolds) {
      throw new ForbiddenException('This conversation is no longer available');
    }
  }

  /** Messages the counterpart wrote after the caller last read the thread. */
  private countUnread(
    thread: {
      id: string;
      customerLastReadAt: Date | null;
      providerLastReadAt: Date | null;
    },
    participant: Participant,
  ) {
    const lastReadAt =
      participant.role === MessageSenderRole.CUSTOMER
        ? thread.customerLastReadAt
        : thread.providerLastReadAt;

    return this.prisma.message.count({
      where: {
        threadId: thread.id,
        senderUserId: { not: participant.userId },
        ...(lastReadAt ? { createdAt: { gt: lastReadAt } } : {}),
      },
    });
  }

  /**
   * One page of a thread's history.
   *
   * Always returned oldest-first, whichever direction it was read in, so a
   * screen never has to know which cursor produced it.
   */
  private async readMessages(
    threadId: string,
    query: { before?: string; after?: string; limit?: number },
  ) {
    const limit = normalizeLimit(query.limit);
    const before = decodeMessageCursor(query.before);
    const after = decodeMessageCursor(query.after);

    if (query.before && !before) {
      throw new BadRequestException('Invalid pagination cursor');
    }
    if (query.after && !after) {
      throw new BadRequestException('Invalid pagination cursor');
    }

    // Everything since a cursor, oldest first: the poll an open thread runs.
    if (after) {
      const messages = await this.prisma.message.findMany({
        where: { threadId, ...cursorFilter(after, 'after') },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        select: messageSelect,
      });

      const page = messages.slice(0, limit);
      return {
        messages: page.map(toMessage),
        hasMoreBefore: false,
        olderCursor: null,
        latestCursor: cursorOf(page.at(-1)) ?? query.after ?? null,
        hasMoreAfter: messages.length > limit,
      };
    }

    // A window of history, newest first in the query and reversed for the
    // caller. Without `before` this is simply the most recent page.
    const messages = await this.prisma.message.findMany({
      where: { threadId, ...(before ? cursorFilter(before, 'before') : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: messageSelect,
    });

    const hasMoreBefore = messages.length > limit;
    const page = messages.slice(0, limit).reverse();

    return {
      messages: page.map(toMessage),
      hasMoreBefore,
      olderCursor: cursorOf(page.at(0)),
      latestCursor: cursorOf(page.at(-1)),
      hasMoreAfter: false,
    };
  }

  /**
   * Refuses a caller who is writing faster than the limit allows.
   *
   * Counted from the `Message` table rather than from memory, so the limit
   * holds across restarts and across every process behind a load balancer, and
   * a test can prove it by writing rows.
   */
  private async assertWithinRateLimit(userId: string) {
    const max = messageRateLimitMax();
    const windowSeconds = messageRateLimitWindowSeconds();
    const since = new Date(Date.now() - windowSeconds * 1000);

    const recent = await this.prisma.message.count({
      where: { senderUserId: userId, createdAt: { gte: since } },
    });

    if (recent >= max) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          code: MESSAGE_RATE_LIMITED_CODE,
          retryAfterSeconds: windowSeconds,
          message: `Çok hızlı mesaj gönderiyorsunuz. Lütfen ${windowSeconds} saniye içinde tekrar deneyin.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

function participantWhere(user: AuthUser): Prisma.MessageThreadWhereInput {
  // Role and id together. A CUSTOMER account can only ever match the customer
  // column and a PROVIDER account only the provider one, so a role change on an
  // account cannot silently move somebody to the other side of a conversation.
  if (user.role === UserRole.CUSTOMER) {
    return { customerUserId: user.id };
  }

  if (user.role === UserRole.PROVIDER) {
    return { providerUserId: user.id };
  }

  // Every other role, SUPER_ADMIN included, is party to nothing. Matching no
  // row is the correct answer rather than an exception: the caller simply has
  // no threads.
  return { id: { in: [] } };
}

function requireParticipant(
  thread: { customerUserId: string; providerUserId: string },
  user: AuthUser,
): Participant {
  if (user.role === UserRole.CUSTOMER && thread.customerUserId === user.id) {
    return { role: MessageSenderRole.CUSTOMER, userId: user.id };
  }

  if (user.role === UserRole.PROVIDER && thread.providerUserId === user.id) {
    return { role: MessageSenderRole.PROVIDER, userId: user.id };
  }

  // Unreachable through the queries above, which already scope by participant.
  // Kept as the last refusal rather than a cast, so a future caller that
  // forgets the scope gets a refusal instead of somebody else's conversation.
  throw new NotFoundException('Message thread not found');
}

/**
 * What either party sees about a thread.
 *
 * The counterpart is named by the name they already show on this job — the
 * business name a customer chose, the name a provider was given on the request.
 * No telephone, no e-mail, no address note, no neighbourhood, no internal id
 * beyond the ones the caller's own screens already carry.
 */
function toThreadSummary(thread: ThreadRow, participant: Participant) {
  const counterpartName =
    participant.role === MessageSenderRole.CUSTOMER
      ? thread.provider.businessName
      : thread.customer.name?.trim() || 'Müşteri';

  return {
    id: thread.id,
    requestId: thread.requestId,
    offerId: thread.offerId,
    viewerRole: participant.role,
    counterpart: { name: counterpartName },
    request: {
      id: thread.request.id,
      requestNumber: thread.request.requestNumber,
      city: thread.request.city,
      district: thread.request.district,
      category: thread.request.category,
    },
    lastMessageAt: thread.lastMessageAt ? thread.lastMessageAt.toISOString() : null,
    /**
     * Whether the counterpart has seen everything this thread holds. A boolean,
     * not a timestamp: the other party is entitled to know their message landed,
     * and to nothing else about how the reader is reading it.
     */
    counterpartHasRead: hasCounterpartRead(thread, participant),
    createdAt: thread.createdAt.toISOString(),
  };
}

function hasCounterpartRead(
  thread: {
    lastMessageAt: Date | null;
    customerLastReadAt: Date | null;
    providerLastReadAt: Date | null;
  },
  participant: Participant,
) {
  if (!thread.lastMessageAt) {
    return false;
  }

  const counterpartLastReadAt =
    participant.role === MessageSenderRole.CUSTOMER
      ? thread.providerLastReadAt
      : thread.customerLastReadAt;

  return Boolean(counterpartLastReadAt && counterpartLastReadAt >= thread.lastMessageAt);
}

function toMessage(message: MessageRow) {
  return {
    id: message.id,
    threadId: message.threadId,
    senderUserId: message.senderUserId,
    senderRole: message.senderRole,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
    cursor: encodeMessageCursor({ createdAt: message.createdAt, id: message.id }),
  };
}

function cursorOf(message: MessageRow | undefined) {
  return message
    ? encodeMessageCursor({ createdAt: message.createdAt, id: message.id })
    : null;
}

/**
 * The keyset predicate for `(createdAt, id)`.
 *
 * Written out rather than delegated to Prisma's `cursor`/`skip`, because that
 * form needs a single unique field and would silently fall back to ordering by
 * id alone — which is not the order this thread is read in.
 */
function cursorFilter(
  cursor: { createdAt: Date; id: string },
  direction: 'before' | 'after',
): Prisma.MessageWhereInput {
  if (direction === 'after') {
    return {
      OR: [
        { createdAt: { gt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { gt: cursor.id } },
      ],
    };
  }

  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

function normalizeLimit(limit: number | undefined) {
  if (limit === undefined) {
    return MESSAGE_PAGE_DEFAULT_LIMIT;
  }

  return Math.min(Math.max(1, Math.trunc(limit)), MESSAGE_PAGE_MAX_LIMIT);
}

/**
 * The body, as it will be stored forever.
 *
 * Trimmed, non-empty, length-capped, and stripped of the control characters a
 * keyboard cannot produce but a script can — everything except the newline and
 * tab a person actually types. It is never parsed as markup: it is stored as
 * text and every surface renders it as text, so there is no representation in
 * which a message is anything but characters.
 */
function normalizeBody(raw: unknown) {
  if (typeof raw !== 'string') {
    throw new BadRequestException('Message body is required');
  }

  const cleaned = stripControlCharacters(raw).trim();

  if (!cleaned) {
    throw new BadRequestException('Mesaj boş olamaz.');
  }

  if (cleaned.length > MESSAGE_BODY_MAX_LENGTH) {
    throw new BadRequestException(
      `Mesaj en fazla ${MESSAGE_BODY_MAX_LENGTH} karakter olabilir.`,
    );
  }

  return cleaned;
}

/**
 * Removes the characters a keyboard cannot produce but a script can.
 *
 * Newline (\n), carriage return (\r) and tab (\t) survive — a person really
 * does type those. Everything else below U+0020, plus the C1 range and the
 * delete character, is dropped: none of them mean anything in a message, and
 * several of them are how a body gets a second life somewhere it is written to
 * a terminal, a log or a CSV.
 */
function stripControlCharacters(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const isKeyboardWhitespace = code === 0x09 || code === 0x0a || code === 0x0d;
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (!isControl || isKeyboardWhitespace) {
      result += character;
    }
  }

  return result;
}
