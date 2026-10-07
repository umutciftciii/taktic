import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SeoNotFoundRouteFamily, SeoNotFoundStatus, ServiceCategoryKind, ServiceCategoryStatus } from '@prisma/client';
import { BackgroundRuns, type BackgroundWorkOwner } from '../../common/background-work';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeCategorySlug } from './category-slug';
import { categoryPath, normalizeSeoPath, seoPathSegments, seoSourceRefusal } from './seo-paths';

/**
 * SEO-004 — the 404 suggestions' only writer.
 *
 * Called by the three public lookups that answer 404 for a record a public
 * page would show (a category by slug, a business by id, a card by id). It is
 * never a general web 404 collector: what reaches it is an address the
 * marketplace itself routes, so an entry is "a page of ours that is not
 * there", not "whatever a scanner tried".
 *
 * ## What is kept, and what never is
 *
 * The normalised path and the route family, and counts: first and last seen,
 * how many times, on how many distinct UTC days. **Never** a query string, a
 * fragment, an IP, a user agent, a cookie or a user — the lookup that calls
 * this has none of them to give, and the signature takes none. A path with a
 * segment carrying `@` or seven digits in a row (an e-mail, a phone number) is
 * dropped before it is even buffered.
 *
 * ## Bounded, three times
 *
 *   in memory   at most {@link NOT_FOUND_LIMITS.bufferMaxKeys} distinct
 *               (path, day) keys between flushes; beyond that a hit is
 *               dropped and only counted
 *   in time     one flush a minute, a handful of statements per key
 *   in the DB   at most {@link NOT_FOUND_LIMITS.openRowCap} OPEN rows; a new
 *               path beyond that is not inserted (existing rows still count)
 *
 * A REJECTED or APPROVED path is suppressed: hits on it change nothing, so a
 * rejected suggestion does not come back. The retention sweep removes OPEN
 * rows unseen for 90 days and REJECTED rows 180 days after the decision.
 *
 * ## Never a redirect
 *
 * Nothing here writes a redirect or suggests a target by similarity. The one
 * candidate it records is deterministic: the path's slug, transliterated by
 * the category slug rule, is a live category's slug (`/categories/kombi-servısı`
 * → `/categories/kombi-servisi`). An operator still decides.
 */

export const NOT_FOUND_LIMITS = {
  bufferMaxKeys: 200,
  flushIntervalMs: 60_000,
  openRowCap: 5000,
  openRetentionDays: 90,
  rejectedSuppressDays: 180,
} as const;

const FLUSH_LOCK_KEY = 'seo-not-found-flush';

type BufferEntry = {
  path: string;
  family: SeoNotFoundRouteFamily;
  day: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  hits: number;
};

export type FlushOutcome = { inserted: number; updated: number; suppressed: number; overCap: number };

/** A segment that may be a person's phone number or e-mail address. */
export function looksPersonal(path: string): boolean {
  return seoPathSegments(path).some((segment) => segment.includes('@') || /\d{7,}/.test(segment));
}

@Injectable()
export class SeoNotFoundRecorder implements OnModuleInit, OnModuleDestroy, BackgroundWorkOwner {
  private readonly logger = new Logger(SeoNotFoundRecorder.name);
  private readonly runs = new BackgroundRuns();
  private buffer = new Map<string, BufferEntry>();
  private timer: NodeJS.Timeout | null = null;
  /** Hits dropped because the buffer was full, since the last flush; logged, never stored. */
  private droppedSinceFlush = 0;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.timer = setInterval(() => this.flushSoon(), NOT_FOUND_LIMITS.flushIntervalMs);
    this.timer.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.runs.whenIdle();
  }

  whenIdle(): Promise<void> {
    return this.runs.whenIdle();
  }

  /**
   * One 404 of a public lookup. `rawPath` is the address as the public page
   * spells it, encoded (`/categories/${encodeURIComponent(slug)}`). Never
   * throws and never awaits: a 404 response is not slowed by its record.
   */
  record(family: SeoNotFoundRouteFamily, rawPath: string, now: Date = new Date()): void {
    try {
      const normalized = normalizeSeoPath(rawPath);
      if (!normalized.ok) return;
      const path = normalized.path;
      if (seoSourceRefusal(path) !== null || looksPersonal(path)) return;

      const day = now.toISOString().slice(0, 10);
      const key = `${path}\n${day}`;
      const entry = this.buffer.get(key);
      if (entry) {
        entry.hits += 1;
        entry.lastSeenAt = now;
        return;
      }
      if (this.buffer.size >= NOT_FOUND_LIMITS.bufferMaxKeys) {
        this.droppedSinceFlush += 1;
        return;
      }
      this.buffer.set(key, { path, family, day, firstSeenAt: now, lastSeenAt: now, hits: 1 });
    } catch {
      // A record is best-effort by definition; the 404 itself must not fail.
    }
  }

  /** Test seam: what is waiting to be written. */
  pending(): number {
    return this.buffer.size;
  }

  /** Test seam: forget what is buffered (the harness empties the database between cases). */
  clear(): void {
    this.buffer = new Map();
    this.droppedSinceFlush = 0;
  }

  private flushSoon() {
    this.runs.start(async () => {
      try {
        await this.flush();
      } catch (error) {
        this.logger.warn(`404 suggestions could not be flushed (${error instanceof Error ? error.name : 'UnknownError'})`);
      }
    });
  }

  /** Writes and empties the buffer. Entries are written oldest day first. */
  async flush(): Promise<FlushOutcome> {
    const entries = [...this.buffer.values()].sort((a, b) => (a.day === b.day ? 0 : a.day < b.day ? -1 : 1));
    const dropped = this.droppedSinceFlush;
    this.buffer = new Map();
    this.droppedSinceFlush = 0;
    if (dropped > 0) this.logger.warn(`404 suggestions: ${dropped} hit(s) dropped (buffer full)`);
    const outcome: FlushOutcome = { inserted: 0, updated: 0, suppressed: 0, overCap: 0 };
    if (entries.length === 0) return outcome;

    const candidates = await this.categoryCandidates(entries);

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${FLUSH_LOCK_KEY}, 0))`;
      let open = await tx.seoNotFoundPath.count({ where: { status: SeoNotFoundStatus.OPEN } });

      for (const entry of entries) {
        const existing = await tx.seoNotFoundPath.findUnique({
          where: { path: entry.path },
          select: { id: true, status: true },
        });
        if (existing) {
          if (existing.status !== SeoNotFoundStatus.OPEN) {
            outcome.suppressed += 1;
            continue;
          }
          await tx.$executeRaw`
            UPDATE "SeoNotFoundPath"
            SET "occurrenceCount" = "occurrenceCount" + ${entry.hits},
                "seenDays" = "seenDays" + CASE
                  WHEN date_trunc('day', "lastSeenAt") < date_trunc('day', ${entry.lastSeenAt}::timestamp) THEN 1
                  ELSE 0 END,
                "firstSeenAt" = LEAST("firstSeenAt", ${entry.firstSeenAt}::timestamp),
                "lastSeenAt" = GREATEST("lastSeenAt", ${entry.lastSeenAt}::timestamp),
                "updatedAt" = now()
            WHERE "id" = ${existing.id} AND "status" = 'OPEN'`;
          outcome.updated += 1;
          continue;
        }
        if (open >= NOT_FOUND_LIMITS.openRowCap) {
          outcome.overCap += 1;
          continue;
        }
        await tx.seoNotFoundPath.create({
          data: {
            path: entry.path,
            routeFamily: entry.family,
            firstSeenAt: entry.firstSeenAt,
            lastSeenAt: entry.lastSeenAt,
            occurrenceCount: entry.hits,
            seenDays: 1,
            candidateTargetPath: candidates.get(entry.path) ?? null,
          },
          select: { id: true },
        });
        open += 1;
        outcome.inserted += 1;
      }
    });
    if (outcome.overCap > 0) this.logger.warn(`404 suggestions: ${outcome.overCap} new path(s) not stored (OPEN cap)`);
    return outcome;
  }

  /**
   * The one deterministic candidate: a category path whose slug, put through
   * the category slug rule, is a different, live category slug.
   */
  private async categoryCandidates(entries: BufferEntry[]): Promise<Map<string, string>> {
    const wanted = new Map<string, string>();
    for (const entry of entries) {
      if (entry.family !== SeoNotFoundRouteFamily.CATEGORY) continue;
      const segments = seoPathSegments(entry.path);
      if (segments.length !== 2 || segments[0] !== 'categories') continue;
      const slug = normalizeCategorySlug(segments[1]);
      if (slug.ok && slug.slug !== segments[1]) wanted.set(entry.path, slug.slug);
    }
    if (wanted.size === 0) return new Map();
    const live = await this.prisma.serviceCategory.findMany({
      where: {
        slug: { in: [...new Set(wanted.values())] },
        status: ServiceCategoryStatus.ACTIVE,
        kind: { in: [ServiceCategoryKind.LEAF, ServiceCategoryKind.ROUTER] },
      },
      select: { slug: true },
    });
    const liveSlugs = new Set(live.map((row) => row.slug));
    const result = new Map<string, string>();
    for (const [path, slug] of wanted) {
      if (liveSlugs.has(slug)) result.set(path, categoryPath(slug));
    }
    return result;
  }

  /** The retention sweep. Returns how many rows each rule removed. */
  async applyRetention(now: Date = new Date()): Promise<{ open: number; rejected: number }> {
    const day = 24 * 60 * 60 * 1000;
    const [open, rejected] = await this.prisma.$transaction([
      this.prisma.seoNotFoundPath.deleteMany({
        where: {
          status: SeoNotFoundStatus.OPEN,
          lastSeenAt: { lt: new Date(now.getTime() - NOT_FOUND_LIMITS.openRetentionDays * day) },
        },
      }),
      this.prisma.seoNotFoundPath.deleteMany({
        where: {
          status: SeoNotFoundStatus.REJECTED,
          decidedAt: { lt: new Date(now.getTime() - NOT_FOUND_LIMITS.rejectedSuppressDays * day) },
        },
      }),
    ]);
    return { open: open.count, rejected: rejected.count };
  }
}
