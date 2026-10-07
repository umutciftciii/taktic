import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  SeoAuditAction,
  SeoAuditEntity,
  SeoNotFoundStatus,
  SeoRedirectOrigin,
  SeoRedirectType,
} from '@prisma/client';
import { AuditPageQueryDto } from '../../../common/admin-audit';
import { runSerializable } from '../../../common/serializable-transaction';
import { PrismaService } from '../../../prisma/prisma.service';
import type { AuthUser } from '../../auth/auth.types';
import { CategoriesService } from '../../categories/categories.service';
import { isPubliclyReachable } from '../../categories/category-taxonomy';
import { normalizeCategorySlug } from '../category-slug';
import { parseCategorySeoContentPatch, readStoredFaq } from '../category-seo-content';
import { readSeoAudit, recordSeoAudit } from '../seo-audit';
import {
  categoryIndexFacts,
  evaluateCategoryIndexability,
  SEO_INDEX_THRESHOLDS,
  type SeoIndexEvaluation,
  type SeoIndexReason,
} from '../seo-index-eligibility';
import { SeoIndexEligibilityService } from '../seo-index-eligibility.service';
import { livePaths } from '../seo-live-pages';
import { categoryPath } from '../seo-paths';
import {
  canonicalInputPath,
  lockRedirectGraph,
  redirectStatus,
  SeoRedirectGraphService,
  translateRedirectWriteError,
} from '../seo-redirect-graph.service';
import { resolveSeoSiteGate } from '../seo-site-gate';
import { SEO_ERROR_CODES, seoBadRequest, seoConflict, seoNotFound } from '../seo.errors';
import {
  ApproveSuggestionDto,
  NonIndexablePagesQueryDto,
  NotFoundListQueryDto,
  RedirectListQueryDto,
  SEO_PAGE_SIZE_DEFAULT,
  SeoPageQueryDto,
  SeoPageType,
  SlugListQueryDto,
} from './seo-admin.dto';

/**
 * SEO-004 — what the four admin SEO screens read and write (PR B draws them).
 *
 * Every figure is computed from the data, now, by the rules the public pages
 * apply; nothing is a placeholder. What the design shows and the data cannot
 * back — visits, redirect hit counts, a sitemap "last generated" time (the
 * sitemap is built per request) — is absent from these responses rather than
 * filled with a number.
 */

type Paging = { page: number; pageSize: number; skip: number };

function paging(query: SeoPageQueryDto | undefined): Paging {
  const page = query?.page ?? 1;
  const pageSize = query?.pageSize ?? SEO_PAGE_SIZE_DEFAULT;
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function pageOf<T>(items: T[], total: number, { page, pageSize }: Paging) {
  return { items, total, page, pageSize, hasNextPage: page * pageSize < total };
}

export type NonIndexablePage = {
  type: SeoPageType;
  id: string;
  label: string;
  /** Who it belongs to, where that is a different record (a card's business). */
  owner: string | null;
  path: string;
  reasons: SeoIndexReason[];
};

const redirectSelect = {
  id: true,
  sourcePath: true,
  targetPath: true,
  type: true,
  active: true,
  origin: true,
  reason: true,
  categoryId: true,
  createdAt: true,
  updatedAt: true,
  deactivatedAt: true,
  createdBy: { select: { id: true, name: true } },
  updatedBy: { select: { id: true, name: true } },
  deactivatedBy: { select: { id: true, name: true } },
} satisfies Prisma.SeoRedirectSelect;

@Injectable()
export class SeoAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SeoIndexEligibilityService) private readonly eligibility: SeoIndexEligibilityService,
    @Inject(SeoRedirectGraphService) private readonly graph: SeoRedirectGraphService,
    @Inject(CategoriesService) private readonly categories: CategoriesService,
  ) {}

  // -------------------------------------------------------------------------
  // Overview and the non-indexable list
  // -------------------------------------------------------------------------

  private async evaluateEverything(now: Date) {
    const [categories, providers, cards, shelf] = await Promise.all([
      this.eligibility.categoryEvaluations(),
      this.eligibility.providerEvaluations(),
      this.eligibility.liveShowcaseCardEvaluations(now),
      this.eligibility.shelfEvaluation(now),
    ]);
    return { categories, providers, cards: [...cards.values()], shelf };
  }

  async overview() {
    const now = new Date();
    const site = resolveSeoSiteGate();
    const { categories, providers, cards, shelf } = await this.evaluateEverything(now);
    const indexableOf = (rows: { evaluation: SeoIndexEvaluation }[]) =>
      rows.filter((row) => row.evaluation.indexable).length;

    // The two pages that are indexable whenever the site is: `/` and `/categories`.
    const staticPages = 2;
    const indexable =
      staticPages +
      (shelf.indexable ? 1 : 0) +
      indexableOf(categories) +
      indexableOf(providers) +
      indexableOf(cards);
    const nonIndexablePages = this.nonIndexablePagesFrom({ categories, providers, cards, shelf });

    const reasonCounts = new Map<string, number>();
    for (const page of nonIndexablePages) {
      for (const code of new Set(page.reasons.map((reason) => reason.code))) {
        reasonCounts.set(code, (reasonCounts.get(code) ?? 0) + 1);
      }
    }

    const [activeRedirects, served, openSuggestions] = await Promise.all([
      this.prisma.seoRedirect.count({ where: { active: true } }),
      this.graph.activeSnapshot(now),
      this.prisma.seoNotFoundPath.count({ where: { status: SeoNotFoundStatus.OPEN } }),
    ]);

    return {
      site,
      generatedAt: now,
      // What the sitemap lists right now: nothing while the site is closed.
      sitemapUrlCount: site.open ? indexable : 0,
      indexableCount: indexable,
      nonIndexableCount: nonIndexablePages.length,
      pages: {
        static: { indexable: staticPages },
        categories: { public: categories.length, indexable: indexableOf(categories) },
        providers: { public: providers.length, indexable: indexableOf(providers) },
        showcaseCards: { live: cards.length, indexable: indexableOf(cards) },
        showcaseShelf: {
          indexable: shelf.indexable,
          indexableCards: indexableOf(cards),
          required: SEO_INDEX_THRESHOLDS.showcaseShelfMinIndexableCards,
        },
      },
      topReasons: [...reasonCounts.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
      thresholds: SEO_INDEX_THRESHOLDS,
      redirects: { active: activeRedirects, served: served.length, notServed: activeRedirects - served.length },
      notFound: { open: openSuggestions },
    };
  }

  private nonIndexablePagesFrom({
    categories,
    providers,
    cards,
    shelf,
  }: Awaited<ReturnType<SeoAdminService['evaluateEverything']>>): NonIndexablePage[] {
    const pages: NonIndexablePage[] = [];
    for (const category of categories) {
      if (category.evaluation.indexable) continue;
      pages.push({
        type: 'CATEGORY',
        id: category.id,
        label: category.name,
        owner: null,
        path: categoryPath(category.slug),
        reasons: category.evaluation.reasons,
      });
    }
    for (const provider of providers) {
      if (provider.evaluation.indexable) continue;
      pages.push({
        type: 'PROVIDER',
        id: provider.id,
        label: provider.name,
        owner: null,
        path: `/isletme/${provider.id}`,
        reasons: provider.evaluation.reasons,
      });
    }
    for (const card of cards) {
      if (card.evaluation.indexable) continue;
      pages.push({
        type: 'SHOWCASE_CARD',
        id: card.cardId,
        label: card.title,
        owner: card.providerName,
        path: `/vitrin/${card.cardId}`,
        reasons: card.evaluation.reasons,
      });
    }
    if (!shelf.indexable) {
      pages.push({ type: 'SHOWCASE_SHELF', id: 'vitrin', label: 'Vitrin', owner: null, path: '/vitrin', reasons: shelf.reasons });
    }
    return pages;
  }

  async listNonIndexablePages(query: NonIndexablePagesQueryDto) {
    const all = this.nonIndexablePagesFrom(await this.evaluateEverything(new Date()));
    const q = query.q?.trim().toLocaleLowerCase('tr-TR');
    const filtered = all.filter(
      (page) =>
        (!query.type || page.type === query.type) &&
        (!query.reason || page.reasons.some((reason) => reason.code === query.reason)) &&
        (!q || page.label.toLocaleLowerCase('tr-TR').includes(q) || page.path.includes(q)),
    );
    const p = paging(query);
    return pageOf(filtered.slice(p.skip, p.skip + p.pageSize), filtered.length, p);
  }

  // -------------------------------------------------------------------------
  // Slugs
  // -------------------------------------------------------------------------

  async listSlugs(query: SlugListQueryDto) {
    const p = paging(query);
    const q = query.q?.trim();
    const where: Prisma.ServiceCategoryWhereInput = q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { slug: { contains: q.toLowerCase(), mode: 'insensitive' } },
          ],
        }
      : {};
    const [total, rows] = await Promise.all([
      this.prisma.serviceCategory.count({ where }),
      this.prisma.serviceCategory.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        skip: p.skip,
        take: p.pageSize,
        select: { id: true, name: true, slug: true, kind: true, status: true },
      }),
    ]);
    const ids = rows.map((row) => row.id);
    const [lastChanges, previous] = await Promise.all([
      ids.length
        ? this.prisma.$queryRaw<{ entityId: string; createdAt: Date }[]>(Prisma.sql`
            SELECT DISTINCT ON ("entityId") "entityId", "createdAt"
            FROM "CatalogAuditLog"
            WHERE "entityType" = 'CATEGORY'
              AND "entityId" IN (${Prisma.join(ids)})
              AND "changes" @> '[{"field":"slug"}]'::jsonb
            ORDER BY "entityId", "createdAt" DESC`)
        : Promise.resolve([]),
      ids.length
        ? this.prisma.seoRedirect.groupBy({
            by: ['categoryId'],
            where: { categoryId: { in: ids }, origin: SeoRedirectOrigin.SLUG_CHANGE, active: true },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);
    const lastChangeBy = new Map(lastChanges.map((row) => [row.entityId, row.createdAt]));
    const previousBy = new Map(previous.map((row) => [row.categoryId, row._count._all]));
    return pageOf(
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        path: categoryPath(row.slug),
        kind: row.kind,
        status: row.status,
        publiclyReachable: isPubliclyReachable(row),
        lastSlugChangeAt: lastChangeBy.get(row.id) ?? null,
        previousAddressCount: previousBy.get(row.id) ?? 0,
      })),
      total,
      p,
    );
  }

  /**
   * What saving this slug would do, without doing it: the derived slug, and
   * whether the old address gets a 301, an address is reclaimed, redirects
   * are retargeted — or why it would be refused. Read-only and advisory: the
   * write re-decides everything under the graph lock.
   */
  async previewSlugChange(categoryId: string, raw: string) {
    const category = await this.prisma.serviceCategory.findUnique({ where: { id: categoryId } });
    if (!category) throw seoNotFound(SEO_ERROR_CODES.CATEGORY_NOT_FOUND, 'Kategori bulunamadı.');
    const derived = normalizeCategorySlug(raw);
    const currentPath = categoryPath(category.slug);
    if (!derived.ok) {
      return { slug: null, refusal: derived.refusal, currentPath, newPath: null, conflict: null, changes: false };
    }
    const newPath = categoryPath(derived.slug);
    if (derived.slug === category.slug) {
      return { slug: derived.slug, refusal: null, currentPath, newPath, conflict: null, changes: false };
    }
    const [taken, holder, incoming] = await Promise.all([
      this.prisma.serviceCategory.findUnique({ where: { slug: derived.slug }, select: { id: true } }),
      this.prisma.seoRedirect.findFirst({
        where: { sourcePath: newPath, active: true },
        select: { id: true, origin: true, categoryId: true },
      }),
      this.prisma.seoRedirect.count({ where: { targetPath: currentPath, active: true } }),
    ]);
    const reclaims = Boolean(
      holder && holder.origin === SeoRedirectOrigin.SLUG_CHANGE && holder.categoryId === category.id,
    );
    const conflict = taken
      ? SEO_ERROR_CODES.SLUG_TAKEN
      : holder && !reclaims
        ? SEO_ERROR_CODES.SLUG_HELD_BY_REDIRECT
        : null;
    return {
      slug: derived.slug,
      refusal: null,
      currentPath,
      newPath,
      conflict,
      changes: true,
      publiclyReachable: isPubliclyReachable(category),
      createsRedirect: isPubliclyReachable(category),
      reclaimsRedirectId: reclaims ? holder!.id : null,
      retargetCount: incoming,
    };
  }

  /** The slug route: free text in, derived slug through the one category write path. */
  async changeSlug(categoryId: string, raw: string, actor: AuthUser) {
    const derived = normalizeCategorySlug(raw);
    if (!derived.ok) {
      throw seoBadRequest(SEO_ERROR_CODES.SLUG_INVALID, 'Kısa ad kullanılamaz.', { refusal: derived.refusal });
    }
    const { category, slugChange } = await this.categories.updateCategoryWithOutcome(
      categoryId,
      { slug: derived.slug },
      actor,
    );
    return {
      category: { id: category.id, name: category.name, slug: category.slug, path: categoryPath(category.slug) },
      redirect: slugChange?.redirect ? this.redirectSummary(slugChange.redirect) : null,
      retargetedRedirectIds: slugChange?.retargeted ?? [],
      reclaimedRedirectIds: slugChange?.reclaimed ?? [],
      deactivatedRedirectIds: slugChange?.deactivated ?? [],
    };
  }

  // -------------------------------------------------------------------------
  // Redirects
  // -------------------------------------------------------------------------

  private redirectSummary(row: {
    id: string;
    sourcePath: string;
    targetPath: string;
    type: SeoRedirectType;
    active: boolean;
    origin: SeoRedirectOrigin;
  }) {
    return {
      id: row.id,
      sourcePath: row.sourcePath,
      targetPath: row.targetPath,
      type: row.type,
      status: redirectStatus(row.type),
      active: row.active,
      origin: row.origin,
    };
  }

  async listRedirects(query: RedirectListQueryDto) {
    const p = paging(query);
    const q = query.q?.trim().toLowerCase();
    const where: Prisma.SeoRedirectWhereInput = {
      ...(query.active !== undefined ? { active: query.active } : {}),
      ...(query.origin ? { origin: query.origin } : {}),
      ...(q ? { OR: [{ sourcePath: { contains: q } }, { targetPath: { contains: q } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.seoRedirect.count({ where }),
      this.prisma.seoRedirect.findMany({
        where,
        orderBy: [{ active: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        skip: p.skip,
        take: p.pageSize,
        select: redirectSelect,
      }),
    ]);
    const live = await livePaths(
      this.prisma,
      rows.filter((row) => row.active).flatMap((row) => [row.sourcePath, row.targetPath]),
    );
    return pageOf(rows.map((row) => this.redirectView(row, live)), total, p);
  }

  private redirectView(row: Prisma.SeoRedirectGetPayload<{ select: typeof redirectSelect }>, live: Set<string>) {
    // `served`: whether the web answers this redirect right now (see
    // SeoRedirectGraphService.activeSnapshot) — false for an inactive row, a
    // target that is no longer a live page, or a source that has become one.
    const served = row.active && live.has(row.targetPath) && !live.has(row.sourcePath);
    return { ...row, status: redirectStatus(row.type), served };
  }

  async getRedirect(id: string, query: AuditPageQueryDto, viewer: AuthUser) {
    const row = await this.prisma.seoRedirect.findUnique({ where: { id }, select: redirectSelect });
    if (!row) throw seoNotFound(SEO_ERROR_CODES.REDIRECT_NOT_FOUND, 'Yönlendirme bulunamadı.');
    const live = row.active ? await livePaths(this.prisma, [row.sourcePath, row.targetPath]) : new Set<string>();
    const history = await readSeoAudit(this.prisma, SeoAuditEntity.REDIRECT, id, query, viewer);
    return { redirect: this.redirectView(row, live), history };
  }

  async createRedirect(input: { sourcePath: string; targetPath: string; type: SeoRedirectType; reason: string }, actor: AuthUser) {
    const created = await this.graph.createManual(input, actor.id);
    return this.redirectSummary(created);
  }

  async updateRedirect(id: string, input: { targetPath?: string; type?: SeoRedirectType; reason?: string }, actor: AuthUser) {
    return this.redirectSummary(await this.graph.update(id, input, actor.id));
  }

  async deactivateRedirect(id: string, input: { reason?: string }, actor: AuthUser) {
    return this.redirectSummary(await this.graph.deactivate(id, input, actor.id));
  }

  // -------------------------------------------------------------------------
  // 404 suggestions
  // -------------------------------------------------------------------------

  async listSuggestions(query: NotFoundListQueryDto) {
    const p = paging(query);
    const where: Prisma.SeoNotFoundPathWhereInput = {
      status: query.status ?? SeoNotFoundStatus.OPEN,
      ...(query.minSeenDays ? { seenDays: { gte: query.minSeenDays } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.seoNotFoundPath.count({ where }),
      this.prisma.seoNotFoundPath.findMany({
        where,
        orderBy: [{ occurrenceCount: 'desc' }, { lastSeenAt: 'desc' }, { id: 'asc' }],
        skip: p.skip,
        take: p.pageSize,
        select: {
          id: true,
          path: true,
          routeFamily: true,
          firstSeenAt: true,
          lastSeenAt: true,
          occurrenceCount: true,
          seenDays: true,
          status: true,
          candidateTargetPath: true,
          decidedAt: true,
          redirectId: true,
          decidedBy: { select: { id: true, name: true } },
        },
      }),
    ]);
    return pageOf(rows, total, p);
  }

  /**
   * Turns one OPEN suggestion into a redirect, in one transaction under the
   * graph lock, through every check a manual redirect passes.
   */
  async approveSuggestion(id: string, input: ApproveSuggestionDto, actor: AuthUser) {
    const explicitTarget = input.targetPath === undefined ? undefined : canonicalInputPath('targetPath', input.targetPath);
    const reason = input.reason?.replace(/\s+/g, ' ').trim() || null;
    try {
      return await runSerializable(
        this.prisma,
        async (tx) => {
          await lockRedirectGraph(tx);
          const row = await tx.seoNotFoundPath.findUnique({ where: { id } });
          if (!row) throw seoNotFound(SEO_ERROR_CODES.SUGGESTION_NOT_FOUND, 'Öneri bulunamadı.');
          if (row.status !== SeoNotFoundStatus.OPEN) {
            throw seoConflict(SEO_ERROR_CODES.SUGGESTION_DECIDED, 'Bu öneri için zaten karar verilmiş.');
          }
          const target = explicitTarget ?? row.candidateTargetPath;
          if (!target) {
            throw seoBadRequest('SEO_TARGET_REQUIRED', 'Gidilecek adres seçilmeli.');
          }
          const redirect = await this.graph.createInTx(tx, {
            source: row.path,
            target,
            type: input.type ?? SeoRedirectType.PERMANENT,
            origin: SeoRedirectOrigin.NOT_FOUND_SUGGESTION,
            reason: reason ?? `404 önerisi onaylandı: ${row.path}`,
            actorId: actor.id,
          });
          const decidedAt = new Date();
          await tx.seoNotFoundPath.update({
            where: { id },
            data: {
              status: SeoNotFoundStatus.APPROVED,
              decidedAt,
              decidedBy: { connect: { id: actor.id } },
              redirect: { connect: { id: redirect.id } },
            },
          });
          await recordSeoAudit(tx, {
            entityType: SeoAuditEntity.NOT_FOUND_PATH,
            entityId: id,
            action: SeoAuditAction.SUGGESTION_APPROVED,
            changes: [
              { field: 'status', from: SeoNotFoundStatus.OPEN, to: SeoNotFoundStatus.APPROVED },
              { field: 'redirect', from: null, to: { id: redirect.id, name: `${redirect.sourcePath} → ${redirect.targetPath}` } },
            ],
            reason,
            actorId: actor.id,
          });
          return { suggestionId: id, status: SeoNotFoundStatus.APPROVED, redirect: this.redirectSummary(redirect) };
        },
        { label: 'seo.suggestions.approve' },
      );
    } catch (error) {
      throw translateRedirectWriteError(error);
    }
  }

  async rejectSuggestion(id: string, input: { reason?: string }, actor: AuthUser) {
    const reason = input.reason?.replace(/\s+/g, ' ').trim() || null;
    return this.prisma.$transaction(async (tx) => {
      const decided = await tx.seoNotFoundPath.updateMany({
        where: { id, status: SeoNotFoundStatus.OPEN },
        data: { status: SeoNotFoundStatus.REJECTED, decidedAt: new Date(), decidedById: actor.id },
      });
      if (decided.count === 0) {
        const exists = await tx.seoNotFoundPath.findUnique({ where: { id }, select: { id: true } });
        if (!exists) throw seoNotFound(SEO_ERROR_CODES.SUGGESTION_NOT_FOUND, 'Öneri bulunamadı.');
        throw seoConflict(SEO_ERROR_CODES.SUGGESTION_DECIDED, 'Bu öneri için zaten karar verilmiş.');
      }
      await recordSeoAudit(tx, {
        entityType: SeoAuditEntity.NOT_FOUND_PATH,
        entityId: id,
        action: SeoAuditAction.SUGGESTION_REJECTED,
        changes: [{ field: 'status', from: SeoNotFoundStatus.OPEN, to: SeoNotFoundStatus.REJECTED }],
        reason,
        actorId: actor.id,
      });
      return { suggestionId: id, status: SeoNotFoundStatus.REJECTED };
    });
  }

  // -------------------------------------------------------------------------
  // Category SEO content
  // -------------------------------------------------------------------------

  async getCategoryContent(categoryId: string) {
    const category = await this.prisma.serviceCategory.findUnique({ where: { id: categoryId } });
    if (!category) throw new NotFoundException('Category not found');
    return {
      id: category.id,
      name: category.name,
      slug: category.slug,
      path: categoryPath(category.slug),
      seoTitle: category.seoTitle,
      seoDescription: category.seoDescription,
      editorialDecisionGuide: category.editorialDecisionGuide,
      editorialPriceFactors: category.editorialPriceFactors,
      editorialFaq: readStoredFaq(category.editorialFaq),
      publiclyReachable: isPubliclyReachable(category),
      evaluation: evaluateCategoryIndexability(categoryIndexFacts(category)),
    };
  }

  async updateCategoryContent(categoryId: string, body: unknown, actor: AuthUser) {
    const patch = parseCategorySeoContentPatch(body);
    await this.categories.updateSeoContent(categoryId, patch, actor);
    return this.getCategoryContent(categoryId);
  }
}
