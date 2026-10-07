import { Inject, Injectable } from '@nestjs/common';
import { Prisma, SeoAuditAction, SeoRedirect, SeoRedirectOrigin, SeoRedirectType } from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { recordRedirectAudit } from './seo-audit';
import { SEO_ERROR_CODES, seoBadRequest, seoConflict, seoNotFound, seoPathInvalid } from './seo.errors';
import { livePaths } from './seo-live-pages';
import { categoryPath, normalizeSeoPath, seoPageRef, seoSourceRefusal } from './seo-paths';

/**
 * SEO-004 — the redirect graph, and the only code that writes it.
 *
 * ## The invariants
 *
 *   1. One active redirect per source (also a partial unique index).
 *   2. No chain: no active redirect's target is another active redirect's
 *      source. A visitor is sent once, to a page, never on a tour.
 *   3. Hence no cycle (a cycle is a chain that closes).
 *   4. A target is a live canonical page when written; a source is not.
 *
 * ## How they are kept under concurrency
 *
 * Every write runs in a SERIALIZABLE transaction (`runSerializable`) that
 * first takes one transaction-scoped advisory lock for the whole graph. The
 * lock makes writers queue; serializable isolation is what makes the queue
 * safe — a writer that waited still began on a snapshot taken before the lock
 * was granted, and PostgreSQL aborts it (40001 → retried with a fresh
 * snapshot) rather than letting it act on a graph another writer has just
 * changed. A category slug change runs inside the category update's own
 * serializable transaction and takes the same lock, so a slug change and a
 * manual redirect can never interleave into a chain.
 *
 * ## Served, not stored
 *
 * The invariants hold when a row is written. What the web serves is decided
 * again on every snapshot ({@link activeSnapshot}): a row whose target has
 * stopped being a live page, or whose source has become one, is left out
 * without being rewritten — and comes back by itself if that changes again.
 */

const GRAPH_LOCK_KEY = 'seo-redirect-graph';

export const REDIRECT_REASON_MAX = 500;

/** What a slug change did to the graph. */
export type SlugChangeOutcome = {
  redirect: SeoRedirect | null;
  retargeted: string[];
  reclaimed: string[];
  deactivated: string[];
};

export type ServedRedirect = { source: string; target: string; status: 301 | 302 };

export function redirectStatus(type: SeoRedirectType): 301 | 302 {
  return type === SeoRedirectType.PERMANENT ? 301 : 302;
}

/** The lock every graph write takes first. */
export async function lockRedirectGraph(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${GRAPH_LOCK_KEY}, 0))`;
}

/** A path from a request body in canonical form, or a 400 naming the field and the refusal. */
export function canonicalInputPath(field: string, raw: unknown): string {
  const result = normalizeSeoPath(typeof raw === 'string' ? raw.trim() : raw);
  if (!result.ok) throw seoPathInvalid(field, result.refusal);
  return result.path;
}

function normalizeReason(raw: unknown, required: boolean): string | null {
  if (raw === undefined || raw === null) {
    if (required) throw seoBadRequest('SEO_REASON_REQUIRED', 'Yönlendirmenin sebebi yazılmalı.');
    return null;
  }
  if (typeof raw !== 'string') throw seoBadRequest('SEO_REASON_INVALID', 'Sebep metin olmalı.');
  const reason = raw.replace(/\s+/g, ' ').trim();
  if (!reason) {
    if (required) throw seoBadRequest('SEO_REASON_REQUIRED', 'Yönlendirmenin sebebi yazılmalı.');
    return null;
  }
  if (reason.length > REDIRECT_REASON_MAX) {
    throw seoBadRequest('SEO_REASON_INVALID', `Sebep en fazla ${REDIRECT_REASON_MAX} karakter olabilir.`);
  }
  return reason;
}

/**
 * The partial unique index on active sources is the last word on invariant 1;
 * a writer that reaches it (rather than the check above it) gets the same 409.
 */
export function translateRedirectWriteError(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return seoConflict(SEO_ERROR_CODES.SOURCE_TAKEN, 'Bu eski adres için zaten etkin bir yönlendirme var.');
  }
  return error;
}

export type NewRedirectInput = {
  sourcePath: unknown;
  targetPath: unknown;
  type: SeoRedirectType;
  reason: unknown;
};

@Injectable()
export class SeoRedirectGraphService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** A manual redirect, from the redirects screen. */
  async createManual(input: NewRedirectInput, actorId: string): Promise<SeoRedirect> {
    const source = canonicalInputPath('sourcePath', input.sourcePath);
    const target = canonicalInputPath('targetPath', input.targetPath);
    const reason = normalizeReason(input.reason, true);
    try {
      return await runSerializable(
        this.prisma,
        async (tx) => {
          await lockRedirectGraph(tx);
          return this.createInTx(tx, {
            source,
            target,
            type: input.type,
            origin: SeoRedirectOrigin.MANUAL,
            reason,
            actorId,
          });
        },
        { label: 'seo.redirects.create' },
      );
    } catch (error) {
      throw translateRedirectWriteError(error);
    }
  }

  /**
   * Inserts one redirect after every check, inside the caller's transaction,
   * which must already hold the graph lock. Used by the manual route and by a
   * 404 suggestion's approval.
   */
  async createInTx(
    tx: Prisma.TransactionClient,
    input: {
      source: string;
      target: string;
      type: SeoRedirectType;
      origin: SeoRedirectOrigin;
      reason: string | null;
      actorId: string;
    },
  ): Promise<SeoRedirect> {
    const { source, target } = input;
    const sourceRefusal = seoSourceRefusal(source);
    if (sourceRefusal) {
      throw seoBadRequest(SEO_ERROR_CODES.SOURCE_RESERVED, 'Bu adres yönlendirme kaynağı olamaz.', {
        refusal: sourceRefusal,
      });
    }
    if (source === target) {
      throw seoBadRequest(SEO_ERROR_CODES.REDIRECT_TO_ITSELF, 'Bir adres kendisine yönlendirilemez.');
    }
    if (!seoPageRef(target)) {
      throw seoBadRequest(SEO_ERROR_CODES.TARGET_NOT_CANONICAL, 'Gidilecek adres sitenin herkese açık bir sayfası olmalı.');
    }

    const taken = await tx.seoRedirect.findFirst({ where: { sourcePath: source, active: true }, select: { id: true } });
    if (taken) {
      throw seoConflict(SEO_ERROR_CODES.SOURCE_TAKEN, 'Bu eski adres için zaten etkin bir yönlendirme var.', {
        redirectId: taken.id,
      });
    }
    await this.assertNoChain(tx, { source, target, excludeId: null });
    await this.assertLiveness(tx, { source, target });

    const created = await tx.seoRedirect.create({
      data: {
        sourcePath: source,
        targetPath: target,
        type: input.type,
        origin: input.origin,
        reason: input.reason,
        createdById: input.actorId,
      },
    });
    await recordRedirectAudit(tx, {
      redirectId: created.id,
      action: SeoAuditAction.REDIRECT_CREATED,
      before: null,
      after: created,
      reason: input.reason,
      actorId: input.actorId,
    });
    return created;
  }

  /** Target, type and reason may change; the source never does. */
  async update(
    id: string,
    input: { targetPath?: unknown; type?: SeoRedirectType; reason?: unknown },
    actorId: string,
  ): Promise<SeoRedirect> {
    const target = input.targetPath === undefined ? undefined : canonicalInputPath('targetPath', input.targetPath);
    const reason = input.reason === undefined ? undefined : normalizeReason(input.reason, false);
    return runSerializable(
      this.prisma,
      async (tx) => {
        await lockRedirectGraph(tx);
        const current = await tx.seoRedirect.findUnique({ where: { id } });
        if (!current) throw seoNotFound(SEO_ERROR_CODES.REDIRECT_NOT_FOUND, 'Yönlendirme bulunamadı.');
        if (!current.active) throw seoConflict(SEO_ERROR_CODES.REDIRECT_INACTIVE, 'Kaldırılmış bir yönlendirme düzenlenemez.');
        if (
          input.type !== undefined &&
          input.type !== current.type &&
          current.origin === SeoRedirectOrigin.SLUG_CHANGE
        ) {
          throw seoBadRequest(
            SEO_ERROR_CODES.SLUG_REDIRECT_PERMANENT,
            'Adres değişikliğinden doğan yönlendirme kalıcı (301) kalmalı.',
          );
        }
        if (target !== undefined && target !== current.targetPath) {
          if (target === current.sourcePath) {
            throw seoBadRequest(SEO_ERROR_CODES.REDIRECT_TO_ITSELF, 'Bir adres kendisine yönlendirilemez.');
          }
          if (!seoPageRef(target)) {
            throw seoBadRequest(
              SEO_ERROR_CODES.TARGET_NOT_CANONICAL,
              'Gidilecek adres sitenin herkese açık bir sayfası olmalı.',
            );
          }
          await this.assertNoChain(tx, { source: current.sourcePath, target, excludeId: current.id });
          const live = await livePaths(tx, [target]);
          if (!live.has(target)) {
            throw seoConflict(SEO_ERROR_CODES.TARGET_NOT_LIVE, 'Gidilecek adres şu an yayında bir sayfa değil.');
          }
        }
        const data: Prisma.SeoRedirectUpdateInput = {};
        if (target !== undefined) data.targetPath = target;
        if (input.type !== undefined) data.type = input.type;
        if (reason !== undefined) data.reason = reason;
        const changed =
          (target !== undefined && target !== current.targetPath) ||
          (input.type !== undefined && input.type !== current.type) ||
          (reason !== undefined && reason !== current.reason);
        if (!changed) return current;

        const updated = await tx.seoRedirect.update({
          where: { id },
          data: { ...data, updatedBy: { connect: { id: actorId } } },
        });
        await recordRedirectAudit(tx, {
          redirectId: id,
          action: SeoAuditAction.REDIRECT_UPDATED,
          before: current,
          after: updated,
          reason: reason ?? null,
          actorId,
        });
        return updated;
      },
      { label: 'seo.redirects.update' },
    );
  }

  /** "Kaldır": the row stays, inactive, with who and when. */
  async deactivate(id: string, input: { reason?: unknown }, actorId: string): Promise<SeoRedirect> {
    const reason = normalizeReason(input.reason, false);
    return runSerializable(
      this.prisma,
      async (tx) => {
        await lockRedirectGraph(tx);
        const current = await tx.seoRedirect.findUnique({ where: { id } });
        if (!current) throw seoNotFound(SEO_ERROR_CODES.REDIRECT_NOT_FOUND, 'Yönlendirme bulunamadı.');
        if (!current.active) throw seoConflict(SEO_ERROR_CODES.REDIRECT_INACTIVE, 'Bu yönlendirme zaten kaldırılmış.');
        return this.deactivateInTx(tx, current, SeoAuditAction.REDIRECT_DEACTIVATED, reason, actorId);
      },
      { label: 'seo.redirects.deactivate' },
    );
  }

  private async deactivateInTx(
    tx: Prisma.TransactionClient,
    current: SeoRedirect,
    action: SeoAuditAction,
    reason: string | null,
    actorId: string,
  ): Promise<SeoRedirect> {
    const updated = await tx.seoRedirect.update({
      where: { id: current.id },
      data: {
        active: false,
        deactivatedAt: new Date(),
        deactivatedBy: { connect: { id: actorId } },
        updatedBy: { connect: { id: actorId } },
      },
    });
    await recordRedirectAudit(tx, { redirectId: current.id, action, before: current, after: updated, reason, actorId });
    return updated;
  }

  /**
   * A category's slug changed, inside the category update's transaction.
   *
   *   1. take the graph lock;
   *   2. the new address must not be another redirect's source — unless that
   *      redirect is this category's own earlier slug change (renaming back:
   *      A → B → A), which is RECLAIMED: deactivated, so the address is a page
   *      again and no cycle is ever written;
   *   3. every active redirect that led to the old address now leads to the
   *      new one (RETARGETED) — the old address is about to become a source,
   *      and nothing may point at a source;
   *   4. a category that was public gets the 301 old → new (SLUG_CHANGE).
   *      One that was not public gets none: its old address was a 404 and
   *      stays one.
   *
   * Any failure throws, and the caller's transaction — the slug update with
   * it — rolls back: a slug never changes without its redirect.
   */
  async applyCategorySlugChange(
    tx: Prisma.TransactionClient,
    input: { categoryId: string; oldSlug: string; newSlug: string; wasPublic: boolean; actorId: string },
  ): Promise<SlugChangeOutcome> {
    await lockRedirectGraph(tx);
    const oldPath = categoryPath(input.oldSlug);
    const newPath = categoryPath(input.newSlug);
    const outcome: SlugChangeOutcome = { redirect: null, retargeted: [], reclaimed: [], deactivated: [] };

    const holder = await tx.seoRedirect.findFirst({ where: { sourcePath: newPath, active: true } });
    if (holder) {
      const ownEarlierAddress =
        holder.origin === SeoRedirectOrigin.SLUG_CHANGE && holder.categoryId === input.categoryId;
      if (!ownEarlierAddress) {
        throw seoConflict(
          SEO_ERROR_CODES.SLUG_HELD_BY_REDIRECT,
          'Bu adres etkin bir yönlendirmenin eski adresi. Önce o yönlendirme kaldırılmalı.',
          { redirectId: holder.id },
        );
      }
      await this.deactivateInTx(
        tx,
        holder,
        SeoAuditAction.REDIRECT_RECLAIMED,
        `Kategori eski adresine geri döndü: ${newPath}`,
        input.actorId,
      );
      outcome.reclaimed.push(holder.id);
    }

    const incoming = await tx.seoRedirect.findMany({ where: { targetPath: oldPath, active: true }, orderBy: { id: 'asc' } });
    for (const redirect of incoming) {
      const updated = await tx.seoRedirect.update({
        where: { id: redirect.id },
        data: { targetPath: newPath, updatedBy: { connect: { id: input.actorId } } },
      });
      await recordRedirectAudit(tx, {
        redirectId: redirect.id,
        action: SeoAuditAction.REDIRECT_RETARGETED,
        before: redirect,
        after: updated,
        reason: `Hedef kategorinin adresi değişti: ${oldPath} → ${newPath}`,
        actorId: input.actorId,
      });
      outcome.retargeted.push(redirect.id);
    }

    if (!input.wasPublic) return outcome;

    // The old address was a live page until this transaction, so no redirect
    // could be served from it — but one written while the category was not
    // public may still be on record. It is superseded by the slug change's
    // own redirect, not left to collide with it.
    const shadowed = await tx.seoRedirect.findFirst({ where: { sourcePath: oldPath, active: true } });
    if (shadowed) {
      await this.deactivateInTx(
        tx,
        shadowed,
        SeoAuditAction.REDIRECT_DEACTIVATED,
        `Kategorinin adres değişikliği bu eski adresin yönlendirmesini devraldı: ${oldPath}`,
        input.actorId,
      );
      outcome.deactivated.push(shadowed.id);
    }

    const reason = `Kategori adresi değişti: ${oldPath} → ${newPath}`;
    const created = await tx.seoRedirect.create({
      data: {
        sourcePath: oldPath,
        targetPath: newPath,
        type: SeoRedirectType.PERMANENT,
        origin: SeoRedirectOrigin.SLUG_CHANGE,
        reason,
        categoryId: input.categoryId,
        createdById: input.actorId,
      },
    });
    await recordRedirectAudit(tx, {
      redirectId: created.id,
      action: SeoAuditAction.REDIRECT_CREATED,
      before: null,
      after: created,
      reason,
      actorId: input.actorId,
    });
    outcome.redirect = created;
    return outcome;
  }

  /**
   * What the web serves: active redirects whose target is a live page and
   * whose source is not, from a source the middleware may answer for.
   */
  async activeSnapshot(now: Date = new Date()): Promise<ServedRedirect[]> {
    const rows = await this.prisma.seoRedirect.findMany({
      where: { active: true },
      select: { sourcePath: true, targetPath: true, type: true },
      orderBy: { sourcePath: 'asc' },
    });
    if (rows.length === 0) return [];
    const live = await livePaths(this.prisma, rows.flatMap((row) => [row.sourcePath, row.targetPath]), now);
    return rows
      .filter((row) => live.has(row.targetPath) && !live.has(row.sourcePath) && seoSourceRefusal(row.sourcePath) === null)
      .map((row) => ({ source: row.sourcePath, target: row.targetPath, status: redirectStatus(row.type) }));
  }

  private async assertNoChain(
    tx: Prisma.TransactionClient,
    input: { source: string; target: string; excludeId: string | null },
  ): Promise<void> {
    const exclude = input.excludeId ? { id: { not: input.excludeId } } : {};
    const onward = await tx.seoRedirect.findFirst({
      where: { sourcePath: input.target, active: true, ...exclude },
      select: { id: true },
    });
    if (onward) {
      throw seoConflict(
        SEO_ERROR_CODES.REDIRECT_CHAIN,
        'Gidilecek adresin kendisi de yönlendiriliyor; zincir (A→B→C) oluşturulamaz.',
        { direction: 'TARGET_IS_SOURCE', redirectIds: [onward.id] },
      );
    }
    const inbound = await tx.seoRedirect.findMany({
      where: { targetPath: input.source, active: true, ...exclude },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    if (inbound.length > 0) {
      throw seoConflict(
        SEO_ERROR_CODES.REDIRECT_CHAIN,
        'Bu eski adrese yönlenen başka yönlendirmeler var; zincir (A→B→C) oluşturulamaz.',
        { direction: 'SOURCE_IS_TARGET', redirectIds: inbound.map((row) => row.id) },
      );
    }
  }

  private async assertLiveness(tx: Prisma.TransactionClient, input: { source: string; target: string }) {
    const live = await livePaths(tx, [input.source, input.target]);
    if (live.has(input.source)) {
      throw seoConflict(
        SEO_ERROR_CODES.SOURCE_IS_LIVE_PAGE,
        'Bu adres yayında bir sayfa; yayındaki bir sayfa yönlendirilemez.',
      );
    }
    if (!live.has(input.target)) {
      throw seoConflict(SEO_ERROR_CODES.TARGET_NOT_LIVE, 'Gidilecek adres şu an yayında bir sayfa değil.');
    }
  }
}
