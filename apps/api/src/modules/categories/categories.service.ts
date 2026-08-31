import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  ProviderStatus,
  ServiceCategory,
  ServiceCategoryKind,
  ServiceCategoryStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { activeProviderInviteFilter } from '../provider-invites/provider-invites.constants';
import {
  canEnterFlow,
  canReceiveRequests,
  isActiveFor,
  isGroupCategory,
  isPubliclyReachable,
  isRouterCategory,
  providerEnrollmentCategoryWhere,
} from './category-taxonomy';
import {
  normalizeCategoryIconKey,
  normalizeCategoryImageUrl,
} from './category-visuals';
import {
  resolveCategorySupplyStatus,
  type CategorySupplyStatus,
} from './category-supply-status';
import {
  questionWithRulesInclude,
  serializeQuestion,
  type QuestionWithRules,
} from './category-serialization';
import { CreateCategoryDto } from './dto/create-category.dto';
import { ResolveRoutingDto } from './dto/resolve-routing.dto';
import { resolveRequestedStatus } from './dto/update-category-status.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

/**
 * How deep a chain of routers may go before the API calls it a loop.
 *
 * Two stages is what the research observed; five leaves room for a third and a
 * fourth without ever letting a mis-wired pair of routers pointing at each
 * other spin. The database cannot forbid that cycle — a router rule is a row,
 * not a tree edge — so the walk carries its own bound and also refuses to visit
 * the same category twice.
 */
const MAX_ROUTER_DEPTH = 5;

/** The code a client reads to tell "wrong answer" from "this route is closed". */
export const ROUTER_TARGET_UNAVAILABLE_CODE = 'ROUTER_TARGET_UNAVAILABLE';

/**
 * What a reader asked for, and what they are entitled to.
 *
 * The two travel together on purpose. `includeInactive` is a *request* for the
 * privileged view — it arrives from the query string, so it is never evidence
 * of anything — and `isSuperAdmin` is the answer the controller derived from
 * the session. A caller cannot supply the second, and the service refuses to
 * honour the first without it.
 */
export type CategoryViewOptions = {
  /**
   * The operator's view: drafts, closed categories, groups, routers, inactive
   * questions and the destinations a router's options lead to.
   */
  includeInactive?: boolean;
  /** Decided from the session by the controller. Never read from the request. */
  isSuperAdmin: boolean;
};

export type CategoryListOptions = CategoryViewOptions & {
  q?: string;
  limit?: number;
};

/**
 * The providers a category's count means: approved ones, and nobody else.
 *
 * A pending application and a suspended profile are both rows in
 * ProviderServiceCategory, and neither can be shown a request or submit an
 * offer. Counting them would make an empty category look staffed, which is the
 * one mistake this number exists to prevent: a released category with no
 * approved provider behind it publishes requests nobody will ever see.
 *
 * It is attached only to the operator's view. Not because a headcount is a
 * secret — it is not — but because "how many businesses have signed up for
 * this" is an operational figure with no reader on the public catalogue, and
 * the narrow response is the one that cannot leak a number somebody later
 * decides was sensitive.
 */
const approvedProviderCount = {
  where: { provider: { status: ProviderStatus.APPROVED } },
} satisfies Prisma.ServiceCategoryCountOutputTypeSelect['providers'];

/**
 * The operator-only columns, stripped on the way out of a public response.
 *
 * `providerEnrollmentOpen` is a recruiting decision — "are we taking
 * applications for this yet" — and it has no reader on the customer catalogue.
 * It rides along by default because the public queries return every scalar
 * column, which is how it reached the wire in the first place: nobody adds a
 * field to that response, the schema does, and a `select` big enough to list
 * every public column is a list somebody has to remember to extend.
 *
 * So the narrowing is stated as a removal rather than an allow-list. It says
 * exactly one thing — this column is not public — and every existing field of
 * the response is untouched, which is what keeps a client written before this
 * change working.
 *
 * `unlimitedPackageEligible` joins it for the same reason and a sharper one:
 * it says whether this category may be sold as part of an unlimited offer
 * package. That is a commercial decision about what providers can buy, and a
 * customer browsing the catalogue has no reader for it at all.
 */
function withoutOperatorColumns<
  T extends { providerEnrollmentOpen: boolean; unlimitedPackageEligible: boolean },
>(category: T): Omit<T, 'providerEnrollmentOpen' | 'unlimitedPackageEligible'> {
  const {
    providerEnrollmentOpen: _providerEnrollmentOpen,
    unlimitedPackageEligible: _unlimitedPackageEligible,
    ...rest
  } = category;
  return rest;
}

/** What every reader of a category listing gets. */
const publicCategoryCounts = {
  questions: true,
  children: true,
} satisfies Prisma.ServiceCategoryCountOutputTypeSelect;

/**
 * That, plus the two figures a release decision is made on.
 *
 * A function rather than a constant because one of the two is a question about
 * the clock: an invitation is live until it expires, so "how many are live" has
 * to be evaluated per request. Pinning `now` once per call rather than letting
 * each row re-read it keeps a listing internally consistent.
 *
 * `activeProviderInvites` deliberately counts something that is **not** a
 * readiness criterion. It is sourcing progress — "somebody has been approached
 * about this service" — and an operator looking at a draft with three live
 * invitations and no approved provider has to read that as still not ready. The
 * screens say so; {@link releaseBlockers} in the admin app never consults it.
 */
function operatorCategoryCounts(
  now: Date = new Date(),
): Prisma.ServiceCategoryCountOutputTypeSelect {
  return {
    ...publicCategoryCounts,
    providers: approvedProviderCount,
    providerInvites: { where: activeProviderInviteFilter(now) },
  };
}

/** The shape the supply status is derived from, as the operator queries return it. */
type CategoryWithOperatorCounts = {
  kind: ServiceCategoryKind;
  status: ServiceCategoryStatus;
  offerCreditCost: number | null;
  _count: { providers: number };
};

/**
 * Attaches the derived status to a row on its way out.
 *
 * Computed here rather than left to the admin app: the figure is what somebody
 * releases a service on, and two clients doing the same arithmetic is two
 * chances to do it differently. A client renders a label for a value it is
 * given.
 *
 * Only ever applied to the operator's query, because only that query computes
 * the approved-provider count the status is derived from.
 */
function withSupplyStatus<T extends CategoryWithOperatorCounts>(
  category: T,
): T & { supplyStatus: CategorySupplyStatus | null } {
  return {
    ...category,
    supplyStatus: resolveCategorySupplyStatus({
      kind: category.kind,
      status: category.status,
      offerCreditCost: category.offerCreditCost,
      approvedProviderCount: category._count.providers,
    }),
  };
}

export type RouterSelection = {
  questionKey: string;
  optionKey: string;
};

/** Where a routed walk ended, and what it consumed getting there. */
export type RoutingResolution = {
  entryCategory: ServiceCategory;
  category: ServiceCategory;
  /**
   * The router questions that were answered on the way, in order. They are real
   * answers to real questions, so the request stores them alongside the leaf's
   * own — losing "what did the customer pick to get here" would make a routed
   * request unreadable to the provider who has to price it.
   */
  routerAnswers: {
    questionId: string;
    questionKey: string;
    questionLabel: string;
    questionType: string;
    value: string;
  }[];
  /**
   * Set when the walk stopped on a router because the caller ran out of
   * selections — i.e. "ask this next", not an error.
   */
  pendingRouterQuestionKey: string | null;
};

/**
 * `providerEnrollmentOpen` may only be written onto a DRAFT leaf.
 *
 * Judged against the category the write produces rather than the one that was
 * there, because the same PATCH may be changing `kind` or `status` too, and the
 * rule belongs to the row being stored.
 *
 * A refusal rather than a silent drop: an operator who thinks they opened a
 * service to applications and did not is exactly the state the switch exists to
 * prevent, and an ignored field is how they would come to think it.
 */
function assertEnrollmentFieldIsWritable(
  requested: boolean | undefined,
  resulting: { kind: ServiceCategoryKind; status: ServiceCategoryStatus },
) {
  if (requested === undefined) {
    return;
  }

  if (resulting.kind !== ServiceCategoryKind.LEAF) {
    throw new BadRequestException(
      'Hizmet veren başvurusu yalnızca hizmet tipindeki kategorilerde ayarlanabilir.',
    );
  }

  if (resulting.status !== ServiceCategoryStatus.DRAFT) {
    throw new BadRequestException(
      'Hizmet veren başvurusu yalnızca taslak hizmetlerde ayarlanabilir. Yayındaki hizmetler her zaman başvuruya açıktır.',
    );
  }
}

/**
 * A service as the application form needs to render it, and not one field more.
 *
 * `availability` is a vocabulary of its own rather than the supply status: it
 * answers "can this take a request today", which is all an applicant is owed.
 * The operator's four-state figure would tell a stranger how many businesses
 * stand behind an unreleased service, and that is an operational number with no
 * reader outside the admin panel.
 */
export type ProviderEnrollmentCategory = {
  id: string;
  name: string;
  slug: string;
  iconKey: string | null;
  imageUrl: string | null;
  parent: { id: string; name: string; slug: string } | null;
  availability: 'LIVE' | 'UPCOMING';
};

@Injectable()
export class CategoriesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * The catalogue.
   *
   * Without `includeInactive` this is the public listing and returns ACTIVE
   * leaves only: a draft is not on sale, a closed category is no longer on
   * sale, a group is a folder and a router is a question. With it the whole
   * tree comes back so the taxonomy can be managed — and that view belongs to a
   * signed-in SUPER_ADMIN, which {@link resolveIncludeInactive} is what
   * enforces.
   */
  async listCategories(options: CategoryListOptions) {
    const includeInactive = this.resolveIncludeInactive(options);
    const q = options.q?.trim();
    const limit =
      options.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
        ? Math.min(Math.floor(options.limit), 100)
        : undefined;

    const where: Prisma.ServiceCategoryWhereInput = {
      ...(includeInactive
        ? {}
        : { status: ServiceCategoryStatus.ACTIVE, kind: ServiceCategoryKind.LEAF }),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { slug: { contains: q.toLowerCase(), mode: 'insensitive' } },
              { description: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const query = {
      where,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      take: limit,
    } satisfies Prisma.ServiceCategoryFindManyArgs;

    // Two shapes rather than one filtered afterwards: the public response never
    // computes the provider count, so there is no field for a later change to
    // forget to strip.
    if (!includeInactive) {
      const publicCategories = await this.prisma.serviceCategory.findMany({
        ...query,
        include: {
          parent: { select: { id: true, name: true, slug: true } },
          _count: { select: publicCategoryCounts },
        },
      });

      return publicCategories.map(withoutOperatorColumns);
    }

    const categories = await this.prisma.serviceCategory.findMany({
      ...query,
      include: {
        parent: { select: { id: true, name: true, slug: true } },
        _count: { select: operatorCategoryCounts() },
      },
    });

    return categories.map(withSupplyStatus);
  }

  /**
   * The catalogue a business signs itself up against.
   *
   * Deliberately reachable signed out. The whole problem this solves is the
   * repairer who finds the marketplace, opens the application form and cannot
   * tick the one service they actually do because it has not been released yet
   * — and that form is reachable without an account by design, since the claim
   * link mailed to the applicant is what hands the application back to them.
   *
   * What that discloses is the name of a draft service an operator has
   * explicitly opened to applications, which is what recruiting for one means.
   * `providerEnrollmentOpen` starts false, so nothing appears here until
   * somebody decides it should.
   *
   * The filter is the shared one, so this list and the selection gate cannot
   * describe two different sets: a category offered here and refused on submit
   * is a dead end with no error the applicant could act on.
   */
  async listProviderEnrollmentCategories(): Promise<ProviderEnrollmentCategory[]> {
    const categories = await this.prisma.serviceCategory.findMany({
      where: providerEnrollmentCategoryWhere,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      // A select rather than a narrowing afterwards: the columns this response
      // must never carry are then never loaded, so there is no field for a
      // later edit to forget to strip.
      select: {
        id: true,
        name: true,
        slug: true,
        iconKey: true,
        imageUrl: true,
        status: true,
        parent: { select: { id: true, name: true, slug: true } },
      },
    });

    return categories.map(({ status, ...category }) => ({
      ...category,
      availability: status === ServiceCategoryStatus.ACTIVE ? 'LIVE' : 'UPCOMING',
    }));
  }

  async getCategoryBySlug(slug: string, options: CategoryViewOptions) {
    const includeInactive = this.resolveIncludeInactive(options);

    const include = {
      parent: { select: { id: true, name: true, slug: true } },
      questions: {
        where: includeInactive ? {} : { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
        include: questionWithRulesInclude,
      },
    } satisfies Prisma.ServiceCategoryInclude;

    // `includeInactive` is the admin path, and the only one that may see where
    // a router leads.
    const serializeQuestions = (questions: QuestionWithRules[]) =>
      questions.map((question) =>
        serializeQuestion(question, { exposeRouterTargets: includeInactive }),
      );

    // Two shapes rather than one narrowed afterwards, for the same reason the
    // listing splits: the public response never computes the approved-provider
    // count, so there is no figure for a later change to forget to strip — and
    // no status derived from one.
    if (includeInactive) {
      const category = await this.prisma.serviceCategory.findUnique({
        where: { slug },
        include: { ...include, _count: { select: operatorCategoryCounts() } },
      });

      if (!category) {
        throw new NotFoundException('Category not found');
      }

      return withSupplyStatus({ ...category, questions: serializeQuestions(category.questions) });
    }

    const category = await this.prisma.serviceCategory.findUnique({
      where: { slug },
      include: { ...include, _count: { select: { children: true } } },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    // A category the public may not reach is indistinguishable from one that
    // does not exist — a 403 would confirm the slug of an unreleased service to
    // anybody who guessed it.
    if (!isPubliclyReachable(category)) {
      throw new NotFoundException('Category not found');
    }

    return withoutOperatorColumns({
      ...category,
      questions: serializeQuestions(category.questions),
    });
  }

  /**
   * Turns "the caller asked for the privileged view" into "the caller gets it",
   * or into a 403.
   *
   * The controller already refuses an unelevated `includeInactive=true` — and
   * it is the layer that can tell a broken credential (401) from one that is
   * simply not an operator's (403). This check exists anyway, because the rule
   * being enforced is *what this data is*, not *what one route does with it*:
   * every reader of a draft category goes through here, so no future caller can
   * reach the wide view by passing a boolean the old signature made it easy to
   * pass by accident.
   */
  private resolveIncludeInactive(options: CategoryViewOptions): boolean {
    if (!options.includeInactive) {
      return false;
    }

    if (!options.isSuperAdmin) {
      throw new ForbiddenException('Insufficient role');
    }

    return true;
  }

  /**
   * Walks a routed flow one selection at a time and says where it ended.
   *
   * The client never decides: it posts the option keys the customer clicked and
   * this method looks each one up in the stored rules. An option that is not on
   * the question, a selection aimed at the wrong question, a target that is not
   * an open leaf — each is refused here rather than accepted and discovered at
   * submission.
   */
  async resolveRouting(
    dto: ResolveRoutingDto,
    isAdmin: boolean,
  ): Promise<RoutingResolution> {
    return this.walkRouting(
      dto.entryCategorySlug,
      (dto.selections ?? []).map((selection) => ({
        questionKey: selection.questionKey,
        optionKey: selection.optionKey,
      })),
      isAdmin,
    );
  }

  /**
   * The routed walk itself, shared by the resolution endpoint and by request
   * creation. Both have to reach the same leaf from the same input — that is
   * the whole reason there is one implementation rather than two.
   */
  async walkRouting(
    entrySlug: string,
    selections: RouterSelection[],
    isAdmin: boolean,
  ): Promise<RoutingResolution> {
    const entryCategory = await this.prisma.serviceCategory.findUnique({
      where: { slug: entrySlug },
    });

    if (!entryCategory) {
      throw new NotFoundException('Category not found');
    }

    if (isGroupCategory(entryCategory)) {
      throw new BadRequestException(
        'Grup kategorisine talep açılamaz; bir hizmet seçmelisiniz.',
      );
    }

    if (!canEnterFlow(entryCategory, isAdmin)) {
      // Same reasoning as the detail endpoint: an unreleased or closed category
      // is simply not there for anybody who may not use it.
      throw new NotFoundException('Category not found');
    }

    const routerAnswers: RoutingResolution['routerAnswers'] = [];
    const visited = new Set<string>([entryCategory.id]);
    let category = entryCategory;
    let cursor = 0;

    while (isRouterCategory(category)) {
      const routerQuestion = await this.loadRouterQuestion(category);

      if (cursor >= selections.length) {
        return {
          entryCategory,
          category,
          routerAnswers,
          pendingRouterQuestionKey: routerQuestion.key,
        };
      }

      const selection = selections[cursor];
      cursor += 1;

      if (!selection) {
        // Unreachable: the bound above is what leaves the loop. Narrowing it
        // here rather than asserting keeps the walk honest under
        // noUncheckedIndexedAccess.
        throw new BadRequestException('Yönlendirme adımı okunamadı.');
      }

      if (selection.questionKey !== routerQuestion.key) {
        throw new BadRequestException(
          `Yönlendirme adımı ${routerQuestion.key} sorusunu bekliyor.`,
        );
      }

      const rule = routerQuestion.routerRules.find(
        (candidate) => candidate.optionKey === selection.optionKey,
      );

      if (!rule) {
        throw new BadRequestException(
          `${routerQuestion.key} sorusunda ${selection.optionKey} seçeneği tanımlı değil.`,
        );
      }

      routerAnswers.push({
        questionId: routerQuestion.id,
        questionKey: routerQuestion.key,
        questionLabel: routerQuestion.label,
        questionType: routerQuestion.type,
        value: rule.optionKey,
      });

      const target = rule.targetCategory;

      if (visited.has(target.id) || routerAnswers.length > MAX_ROUTER_DEPTH) {
        throw new ConflictException({
          statusCode: HttpStatus.CONFLICT,
          error: 'Conflict',
          code: ROUTER_TARGET_UNAVAILABLE_CODE,
          message: 'Yönlendirme zinciri bir hizmete ulaşmıyor.',
        });
      }

      visited.add(target.id);
      category = target;

      // A router may point at another router (two-stage routing) or at a leaf.
      // Anything else — a group, a draft the caller may not use, a category
      // that has been closed — means this route currently leads nowhere, and
      // that is a 409 rather than a 404: the entry category the customer chose
      // is fine, the destination behind their answer is not.
      const usable = isRouterCategory(category)
        ? canEnterFlow(category, isAdmin)
        : canReceiveRequests(category, isAdmin);

      if (!usable) {
        throw new ConflictException({
          statusCode: HttpStatus.CONFLICT,
          error: 'Conflict',
          code: ROUTER_TARGET_UNAVAILABLE_CODE,
          message: 'Seçtiğiniz seçeneğe bağlı hizmet şu anda talep almıyor.',
        });
      }
    }

    if (cursor < selections.length) {
      throw new BadRequestException('Yönlendirme adımlarından fazlası gönderildi.');
    }

    if (!canReceiveRequests(category, isAdmin)) {
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: ROUTER_TARGET_UNAVAILABLE_CODE,
        message: 'Seçtiğiniz seçeneğe bağlı hizmet şu anda talep almıyor.',
      });
    }

    return { entryCategory, category, routerAnswers, pendingRouterQuestionKey: null };
  }

  /**
   * A ROUTER category's single routing question.
   *
   * "Exactly one" is a rule QuestionsService enforces on every write; this is
   * where a category that somehow has none or two stops the flow instead of
   * quietly picking one.
   */
  private async loadRouterQuestion(category: ServiceCategory) {
    const questions = await this.prisma.serviceRequestQuestion.findMany({
      where: { categoryId: category.id, isActive: true, isRouter: true },
      include: {
        routerRules: { include: { targetCategory: true } },
      },
      orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
    });

    const [routerQuestion] = questions;

    if (questions.length !== 1 || !routerQuestion) {
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: ROUTER_TARGET_UNAVAILABLE_CODE,
        message: 'Bu yönlendirici kategori henüz yapılandırılmamış.',
      });
    }

    return routerQuestion;
  }

  async createCategory(dto: CreateCategoryDto) {
    const parentId = normalizeNullableString(dto.parentId);
    if (parentId) {
      await this.assertParentIsGroup(parentId);
    }

    // `isActive` is the pre-taxonomy spelling of the same switch; ACTIVE is
    // what a payload that mentions neither has always meant.
    const status = resolveRequestedStatus(dto) ?? ServiceCategoryStatus.ACTIVE;
    const kind = dto.kind ?? ServiceCategoryKind.LEAF;

    assertEnrollmentFieldIsWritable(dto.providerEnrollmentOpen, { kind, status });

    try {
      return await this.prisma.serviceCategory.create({
        data: {
          name: normalizeRequiredString(dto.name, 'Category name'),
          slug: normalizeSlug(dto.slug),
          description: normalizeNullableString(dto.description),
          offerCreditCost: dto.offerCreditCost,
          parentId,
          kind,
          status,
          // Absent means closed, which is the column default and the safe one:
          // a category nobody has opened recruits nobody.
          providerEnrollmentOpen: dto.providerEnrollmentOpen ?? false,
          // Opt-in, always. A newly created or newly imported category is never
          // sellable as part of an unlimited package until somebody says so.
          unlimitedPackageEligible: dto.unlimitedPackageEligible ?? false,
          // Written together, never one without the other: see
          // ServiceCategoryStatus in the schema.
          isActive: isActiveFor(status),
          imageUrl: normalizeCategoryImageUrl(dto.imageUrl, 'imageUrl') ?? null,
          coverImageUrl:
            normalizeCategoryImageUrl(dto.coverImageUrl, 'coverImageUrl') ?? null,
          iconKey: normalizeCategoryIconKey(dto.iconKey) ?? null,
          sortOrder: dto.sortOrder ?? 0,
        },
      });
    } catch (error) {
      handleCategoryWriteError(error);
    }
  }

  async updateCategory(id: string, dto: UpdateCategoryDto) {
    const existing = await this.ensureCategoryExists(id);

    const imageUrl = normalizeCategoryImageUrl(dto.imageUrl, 'imageUrl');
    const coverImageUrl = normalizeCategoryImageUrl(dto.coverImageUrl, 'coverImageUrl');
    const iconKey = normalizeCategoryIconKey(dto.iconKey);

    if (dto.parentId !== undefined) {
      const parentId = normalizeNullableString(dto.parentId);
      if (parentId) {
        if (parentId === id) {
          throw new BadRequestException('Bir kategori kendi üst kategorisi olamaz');
        }
        await this.assertParentIsGroup(parentId);
        await this.assertNotDescendant(id, parentId);
      }
    }

    if (dto.kind !== undefined && dto.kind !== existing.kind) {
      await this.assertKindChangeIsSafe(existing, dto.kind);
    }

    const status = resolveRequestedStatus(dto);

    assertEnrollmentFieldIsWritable(dto.providerEnrollmentOpen, {
      kind: dto.kind ?? existing.kind,
      status: status ?? existing.status,
    });

    try {
      return await this.prisma.serviceCategory.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: normalizeRequiredString(dto.name, 'Category name') } : {}),
          ...(dto.slug !== undefined ? { slug: normalizeSlug(dto.slug) } : {}),
          ...(dto.description !== undefined
            ? { description: normalizeNullableString(dto.description) }
            : {}),
          // Only written when the caller sends it. There is no branch that sets
          // it to null: unpricing a category is not a supported operation.
          ...(dto.offerCreditCost !== undefined
            ? { offerCreditCost: dto.offerCreditCost }
            : {}),
          ...(dto.parentId !== undefined ? { parentId: normalizeNullableString(dto.parentId) } : {}),
          ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
          ...(status !== undefined ? { status, isActive: isActiveFor(status) } : {}),
          ...(imageUrl !== undefined ? { imageUrl } : {}),
          ...(coverImageUrl !== undefined ? { coverImageUrl } : {}),
          ...(iconKey !== undefined ? { iconKey } : {}),
          ...(dto.providerEnrollmentOpen !== undefined
            ? { providerEnrollmentOpen: dto.providerEnrollmentOpen }
            : {}),
          ...(dto.unlimitedPackageEligible !== undefined
            ? { unlimitedPackageEligible: dto.unlimitedPackageEligible }
            : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        },
      });
    } catch (error) {
      handleCategoryWriteError(error);
    }
  }

  async updateCategoryStatus(id: string, status: ServiceCategoryStatus) {
    await this.ensureCategoryExists(id);

    return this.prisma.serviceCategory.update({
      where: { id },
      data: { status, isActive: isActiveFor(status) },
    });
  }

  /**
   * Deletion, and the four reasons it is refused.
   *
   * A category is the anchor of other people's records — a customer's request,
   * a provider's service list, a router's destination — and a subtree's parent.
   * Removing one that anything still points at either loses that link silently
   * or fails deep inside the database with an error nobody can act on. The
   * checks are here so the refusal names what is in the way.
   *
   * Closing a category (INACTIVE) is the operation for "stop selling this";
   * deletion is only for one nothing ever used.
   */
  async deleteCategory(id: string) {
    await this.ensureCategoryExists(id);

    const [children, requests, entryRequests, providers, routerRules, questions] =
      await Promise.all([
        this.prisma.serviceCategory.count({ where: { parentId: id } }),
        this.prisma.serviceRequest.count({ where: { categoryId: id } }),
        this.prisma.serviceRequest.count({ where: { entryCategoryId: id } }),
        this.prisma.providerServiceCategory.count({ where: { categoryId: id } }),
        this.prisma.serviceCategoryRouterRule.count({ where: { targetCategoryId: id } }),
        this.prisma.serviceRequestQuestion.count({ where: { categoryId: id } }),
      ]);

    if (children > 0) {
      throw new ConflictException(
        `Bu kategorinin ${children} alt kategorisi var. Önce alt kategorileri taşıyın veya silin.`,
      );
    }

    if (requests > 0 || entryRequests > 0) {
      throw new ConflictException(
        'Bu kategoriye bağlı talepler var. Kategoriyi silmek yerine kapatın.',
      );
    }

    if (providers > 0) {
      throw new ConflictException(
        'Bu kategoriyi seçmiş hizmet verenler var. Kategoriyi silmek yerine kapatın.',
      );
    }

    if (routerRules > 0) {
      throw new ConflictException(
        'Bu kategori bir yönlendirme kuralının hedefi. Önce kuralı kaldırın.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      if (questions > 0) {
        // Conditions and router rules hang off the questions and go with them;
        // no answer can exist here, because a category with requests was
        // already refused above.
        await tx.serviceRequestQuestion.deleteMany({ where: { categoryId: id } });
      }
      await tx.serviceCategory.delete({ where: { id } });
    });

    return { id, deleted: true };
  }

  /** A parent is a folder. Hanging a service under a service is not a tree. */
  private async assertParentIsGroup(parentId: string) {
    const parent = await this.prisma.serviceCategory.findUnique({
      where: { id: parentId },
      select: { id: true, kind: true },
    });

    if (!parent) {
      throw new BadRequestException('Parent category does not exist');
    }

    if (parent.kind !== ServiceCategoryKind.GROUP) {
      throw new BadRequestException('Üst kategori yalnızca GROUP tipinde olabilir');
    }
  }

  /**
   * Refuses a move that would put a category under one of its own descendants —
   * the way a tree becomes a ring nobody can render or delete out of.
   */
  private async assertNotDescendant(id: string, candidateParentId: string) {
    let cursor: string | null = candidateParentId;

    for (let depth = 0; cursor && depth <= MAX_ROUTER_DEPTH * 2; depth += 1) {
      if (cursor === id) {
        throw new BadRequestException('Bir kategori kendi alt ağacına taşınamaz');
      }

      const parent: { parentId: string | null } | null =
        await this.prisma.serviceCategory.findUnique({
          where: { id: cursor },
          select: { parentId: true },
        });

      cursor = parent?.parentId ?? null;
    }
  }

  /**
   * Changing what a category *is* after it has been used.
   *
   * A leaf that already carries requests cannot become a group or a router:
   * those kinds are never the category a request points at, so the change would
   * leave existing requests attached to something that, by the rules everywhere
   * else in this file, cannot hold them.
   */
  private async assertKindChangeIsSafe(
    existing: { id: string; kind: ServiceCategoryKind },
    nextKind: ServiceCategoryKind,
  ) {
    if (nextKind === ServiceCategoryKind.LEAF) {
      return;
    }

    const [requests, providers] = await Promise.all([
      this.prisma.serviceRequest.count({ where: { categoryId: existing.id } }),
      this.prisma.providerServiceCategory.count({ where: { categoryId: existing.id } }),
    ]);

    if (requests > 0) {
      throw new ConflictException(
        'Bu kategoriye bağlı talepler var; tipi hizmet dışına çevrilemez.',
      );
    }

    if (providers > 0) {
      throw new ConflictException(
        'Bu kategoriyi seçmiş hizmet verenler var; tipi hizmet dışına çevrilemez.',
      );
    }
  }

  private async ensureCategoryExists(id: string) {
    const category = await this.prisma.serviceCategory.findUnique({
      where: { id },
      select: { id: true, kind: true, status: true },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    return category;
  }
}

function normalizeNullableString(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeRequiredString(value: string, fieldName: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new BadRequestException(`${fieldName} cannot be empty`);
  }

  return trimmed;
}

function normalizeSlug(value: string) {
  const slug = normalizeRequiredString(value, 'Category slug');

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new BadRequestException('Category slug must be lowercase and URL-safe');
  }

  return slug;
}

function handleCategoryWriteError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      throw new ConflictException('Category slug already exists');
    }

    if (error.code === 'P2003') {
      throw new BadRequestException('Parent category does not exist');
    }
  }

  throw error;
}
