import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CampaignAuditAction,
  CampaignStatus,
  Prisma,
  type CampaignBenefitType,
  type CampaignEligibilityFact,
  type CampaignStackPolicy,
  type CampaignTrigger,
} from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { OPERATIONS_SETTINGS_ID } from '../operations-settings/operations-settings.service';
import { CampaignEngineSettingsService } from './campaign-engine-settings.service';
import { CAMPAIGN_LIST_DEFAULT_LIMIT } from './dto/list-campaigns.dto';
import { istanbulDay } from './engine/campaign-engine.repository';
import { type CampaignFactSource, FactSourceRegistry } from './engine/fact-source-registry';
import {
  CAMPAIGN_ACTIVATION_ERROR_MESSAGES,
  CAMPAIGN_RULE_ERROR_MESSAGES,
  type CampaignActivationError,
  type CampaignRuleError,
} from './rules/errors';
import { type CampaignDefinition, type CampaignDefinitionSummary, isAnyGroup } from './rules/types';
import { collectPackageSlugs, validateCampaignDefinition } from './rules/validator';

/**
 * Campaign definitions, their immutable versions and the campaign lifecycle
 * (CMP-002 S1 + S2B2).
 *
 * Four rules, in the order they are enforced:
 *
 * 1. Validate before write. A definition goes through the rule validator —
 *    with the package catalogue supplied — before any transaction opens; an
 *    invalid one produces a 400 and no row of any kind.
 * 2. Versions are written, never updated. A revision is a new CampaignVersion
 *    with the next number and a move of `Campaign.currentVersionId`, in one
 *    Serializable transaction that first takes the campaign row's lock so two
 *    operators saving at once serialise rather than collide. A revision may be
 *    added to a DRAFT, ACTIVE or PAUSED campaign — it changes what is *stored*,
 *    never what *runs*: the engine reads `activeVersionId`, which only
 *    activation moves.
 * 3. The lifecycle is DRAFT → ACTIVE ⇄ PAUSED → ENDED, ENDED terminal
 *    (CMP-001 §2.1). Activation and resumption are refused while the engine
 *    switch is off (`CAMPAIGN_ENGINE_DISABLED`) and are gated on the version
 *    being sound *now*: its definition re-parsed, its window not yet closed,
 *    its limits not below what the campaign already consumed
 *    (`LIMIT_BELOW_CONSUMED`), and a booted PROVIDER-role writer registered
 *    for every fact source it depends on (`FACT_SOURCE_UNAVAILABLE`). All of
 *    it is judged inside the transaction that writes the state, and a
 *    refusal writes nothing. Pause and end are always possible.
 * 4. Nothing here grants anything. Activation writes `Campaign` and
 *    `CampaignAuditLog` and no other table; the engine switch is read, never
 *    written, through this module.
 */

export const CAMPAIGN_DEFINITION_INVALID = 'CAMPAIGN_DEFINITION_INVALID';
export const CAMPAIGN_KEY_TAKEN = 'CAMPAIGN_KEY_TAKEN';
export const CAMPAIGN_NOT_FOUND = 'CAMPAIGN_NOT_FOUND';
export const CAMPAIGN_VERSION_NOT_FOUND = 'CAMPAIGN_VERSION_NOT_FOUND';
export const CAMPAIGN_ENDED = 'CAMPAIGN_ENDED';
export const CAMPAIGN_INVALID_TRANSITION = 'CAMPAIGN_INVALID_TRANSITION';
export const CAMPAIGN_ENGINE_DISABLED = 'CAMPAIGN_ENGINE_DISABLED';
export const CAMPAIGN_ACTIVATION_REFUSED = 'CAMPAIGN_ACTIVATION_REFUSED';

/** The condition types whose truth depends on a registered fact writer. */
const CONDITION_FACT_SOURCES: Readonly<Record<string, CampaignFactSource>> = {
  EMAIL_VERIFIED: 'EMAIL_VERIFIED',
  PHONE_VERIFIED: 'PHONE_VERIFIED',
};

const AUDIT_PAGE = 100;

/** Top-level definition fields, in the order a diff reports them. */
const DEFINITION_FIELDS = [
  'trigger',
  'eligibility',
  'conditions',
  'benefit',
  'limits',
  'window',
  'stackPolicy',
  'priority',
] as const;

type ActorView = { id: string; name: string | null };

export type CampaignView = {
  id: string;
  key: string;
  name: string;
  status: CampaignStatus;
  /** The version the engine evaluates while ACTIVE/PAUSED; null until first activation. */
  activeVersionId: string | null;
  /** Cumulative, never decremented (CMP-001 §10.2). */
  redemptionCount: number;
  budgetConsumedCredits: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy: ActorView;
};

export type CampaignVersionSummaryView = {
  id: string;
  versionNumber: number;
  trigger: CampaignTrigger;
  eligibilityFacts: CampaignEligibilityFact[];
  factSetKey: string | null;
  benefitType: CampaignBenefitType;
  benefitCredits: number;
  benefitExpiresInDays: number;
  maxRedemptionsPerProvider: number;
  maxRedemptionsGlobal: number | null;
  maxRedemptionsPerDay: number | null;
  budgetCredits: number | null;
  windowStartAt: Date | null;
  windowEndAt: Date | null;
  stackPolicy: CampaignStackPolicy;
  priority: number;
  createdAt: Date;
  createdBy: ActorView;
};

export type CampaignVersionView = CampaignVersionSummaryView & { definition: CampaignDefinition };

export type CampaignAuditView = {
  id: string;
  action: CampaignAuditAction;
  campaignVersionId: string | null;
  actor: ActorView;
  summary: Prisma.JsonValue | null;
  createdAt: Date;
};

export type CampaignValidationView = {
  valid: boolean;
  errors: CampaignRuleError[];
  summary: CampaignDefinitionSummary | null;
};

const actorSelect = { select: { id: true, name: true } } as const;

const versionSelect = {
  id: true,
  versionNumber: true,
  trigger: true,
  eligibilityFacts: true,
  factSetKey: true,
  definition: true,
  benefitType: true,
  benefitCredits: true,
  benefitExpiresInDays: true,
  maxRedemptionsPerProvider: true,
  maxRedemptionsGlobal: true,
  maxRedemptionsPerDay: true,
  budgetCredits: true,
  windowStartAt: true,
  windowEndAt: true,
  stackPolicy: true,
  priority: true,
  createdAt: true,
  createdBy: actorSelect,
} satisfies Prisma.CampaignVersionSelect;

type VersionRow = Prisma.CampaignVersionGetPayload<{ select: typeof versionSelect }>;

const campaignSelect = {
  id: true,
  key: true,
  name: true,
  status: true,
  activeVersionId: true,
  redemptionCount: true,
  budgetConsumedCredits: true,
  createdAt: true,
  updatedAt: true,
  createdBy: actorSelect,
  currentVersion: { select: versionSelect },
  activeVersion: { select: versionSelect },
} satisfies Prisma.CampaignSelect;

type CampaignRow = Prisma.CampaignGetPayload<{ select: typeof campaignSelect }>;

@Injectable()
export class CampaignsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CampaignEngineSettingsService)
    private readonly engineSettings: CampaignEngineSettingsService,
    @Inject(FactSourceRegistry) private readonly factSources: FactSourceRegistry,
  ) {}

  // ───────────────────────────── validation ─────────────────────────────

  /**
   * The full judgement on a definition, package catalogue included. Pure
   * apart from one read of package slugs, and it writes nothing.
   */
  async validate(input: unknown): Promise<
    | { ok: true; definition: CampaignDefinition; summary: CampaignDefinitionSummary }
    | { ok: false; errors: CampaignRuleError[] }
  > {
    const structural = validateCampaignDefinition(input);
    if (!structural.ok) {
      return structural;
    }

    const slugs = collectPackageSlugs(structural.definition);
    if (slugs.length === 0) {
      return structural;
    }

    const rows = await this.prisma.offerCreditPackage.findMany({
      where: { slug: { in: slugs } },
      select: { slug: true },
    });
    return validateCampaignDefinition(input, {
      knownPackageSlugs: new Set(rows.map((row) => row.slug)),
    });
  }

  async validateForAdmin(input: unknown): Promise<CampaignValidationView> {
    const result = await this.validate(input);
    return result.ok
      ? { valid: true, errors: [], summary: result.summary }
      : { valid: false, errors: result.errors, summary: null };
  }

  // ─────────────────────────────── writes ───────────────────────────────

  async create(input: { key: string; name: string; definition: unknown }, actorId: string) {
    const validated = await this.validate(input.definition);
    if (!validated.ok) {
      throw definitionInvalid(validated.errors);
    }
    const name = input.name.trim();
    if (name.length === 0) {
      throw new BadRequestException('name boş olamaz');
    }

    let campaignId: string;
    try {
      campaignId = await runSerializable(
        this.prisma,
        async (tx) => {
          const existing = await tx.campaign.findUnique({
            where: { key: input.key },
            select: { id: true },
          });
          if (existing) {
            throw keyTaken();
          }

          const campaign = await tx.campaign.create({
            data: { key: input.key, name, status: CampaignStatus.DRAFT, createdById: actorId },
            select: { id: true },
          });
          await tx.campaignAuditLog.create({
            data: { campaignId: campaign.id, action: CampaignAuditAction.CREATED, actorId },
          });
          await this.writeVersion(tx, {
            campaignId: campaign.id,
            versionNumber: 1,
            previous: null,
            validated,
            actorId,
          });
          return campaign.id;
        },
        { label: 'campaigns.create' },
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw keyTaken();
      }
      throw error;
    }

    return this.getForAdmin(campaignId);
  }

  async addVersion(campaignId: string, definition: unknown, actorId: string) {
    const validated = await this.validate(definition);
    if (!validated.ok) {
      throw definitionInvalid(validated.errors);
    }

    await runSerializable(
      this.prisma,
      async (tx) => {
        // The campaign row's lock first, so a second operator saving the same
        // draft waits here and, once the first commit lands, is told to retry
        // (40001 → P2034 → runSerializable) rather than reading a stale
        // version number. A model update rather than a raw `FOR UPDATE`: the
        // serialization failure of a raw query surfaces as P2010, which the
        // retry helper rightly does not recognise.
        const campaign = await tx.campaign
          .update({
            where: { id: campaignId },
            data: { updatedAt: new Date() },
            select: { status: true },
          })
          .catch((error: unknown) => {
            if (isRecordMissing(error)) {
              throw campaignNotFound();
            }
            throw error;
          });
        if (campaign.status === CampaignStatus.ENDED) {
          throw campaignEnded();
        }

        const latest = await tx.campaignVersion.findFirst({
          where: { campaignId },
          orderBy: { versionNumber: 'desc' },
          select: { versionNumber: true, definition: true },
        });
        await this.writeVersion(tx, {
          campaignId,
          versionNumber: (latest?.versionNumber ?? 0) + 1,
          previous: latest?.definition ?? null,
          validated,
          actorId,
        });
      },
      { label: 'campaigns.addVersion' },
    );

    return this.getForAdmin(campaignId);
  }

  /** The one place a CampaignVersion row is written. There is no counterpart that updates one. */
  private async writeVersion(
    tx: Prisma.TransactionClient,
    args: {
      campaignId: string;
      versionNumber: number;
      previous: Prisma.JsonValue | null;
      validated: { definition: CampaignDefinition; summary: CampaignDefinitionSummary };
      actorId: string;
    },
  ) {
    const { definition, summary } = args.validated;
    const version = await tx.campaignVersion.create({
      data: {
        campaignId: args.campaignId,
        versionNumber: args.versionNumber,
        trigger: definition.trigger as CampaignTrigger,
        eligibilityFacts: summary.eligibilityFacts as CampaignEligibilityFact[],
        factSetKey: summary.factSetKey,
        definition: definition as unknown as Prisma.InputJsonValue,
        benefitType: definition.benefit.type as CampaignBenefitType,
        benefitCredits: definition.benefit.credits,
        benefitExpiresInDays: definition.benefit.expiresInDays,
        maxRedemptionsPerProvider: definition.limits.maxRedemptionsPerProvider,
        maxRedemptionsGlobal: definition.limits.maxRedemptionsGlobal,
        maxRedemptionsPerDay: definition.limits.maxRedemptionsPerDay,
        budgetCredits: definition.limits.budgetCredits,
        windowStartAt: definition.window.startAt ? new Date(definition.window.startAt) : null,
        windowEndAt: definition.window.endAt ? new Date(definition.window.endAt) : null,
        stackPolicy: definition.stackPolicy as CampaignStackPolicy,
        priority: definition.priority,
        createdById: args.actorId,
      },
      select: { id: true },
    });

    await tx.campaign.update({
      where: { id: args.campaignId },
      data: { currentVersionId: version.id },
      select: { id: true },
    });

    await tx.campaignAuditLog.create({
      data: {
        campaignId: args.campaignId,
        action: CampaignAuditAction.VERSION_CREATED,
        campaignVersionId: version.id,
        actorId: args.actorId,
        summary: {
          versionNumber: args.versionNumber,
          trigger: definition.trigger,
          benefitCredits: definition.benefit.credits,
          benefitExpiresInDays: definition.benefit.expiresInDays,
          maxRedemptionsPerProvider: definition.limits.maxRedemptionsPerProvider,
          changedFields: changedFields(args.previous, definition),
        },
      },
    });
  }

  // ─────────────────────────────── reads ────────────────────────────────

  async list(query: { limit?: number; cursor?: string }) {
    const take = query.limit ?? CAMPAIGN_LIST_DEFAULT_LIMIT;
    const [engineEnabled, rows] = await Promise.all([
      this.engineSettings.isEngineEnabled(),
      this.prisma.campaign.findMany({
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: take + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        select: campaignSelect,
      }),
    ]);

    const page = rows.slice(0, take);
    return {
      engineEnabled,
      items: page.map((row) => ({
        ...campaignView(row),
        currentVersion: row.currentVersion ? versionSummaryView(row.currentVersion) : null,
        activeVersion: row.activeVersion ? versionSummaryView(row.activeVersion) : null,
      })),
      nextCursor: rows.length > take ? page[page.length - 1]!.id : null,
    };
  }

  async getForAdmin(campaignId: string) {
    const [engineEnabled, row] = await Promise.all([
      this.engineSettings.isEngineEnabled(),
      this.prisma.campaign.findUnique({ where: { id: campaignId }, select: campaignSelect }),
    ]);
    if (!row) {
      throw campaignNotFound();
    }

    const [versions, audit] = await Promise.all([
      this.prisma.campaignVersion.findMany({
        where: { campaignId },
        orderBy: { versionNumber: 'desc' },
        select: versionSelect,
      }),
      this.prisma.campaignAuditLog.findMany({
        where: { campaignId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: AUDIT_PAGE,
        select: {
          id: true,
          action: true,
          campaignVersionId: true,
          summary: true,
          createdAt: true,
          actor: actorSelect,
        },
      }),
    ]);

    return {
      engineEnabled,
      campaign: campaignView(row),
      currentVersion: row.currentVersion ? versionView(row.currentVersion) : null,
      activeVersion: row.activeVersion ? versionView(row.activeVersion) : null,
      versions: versions.map(versionView),
      audit: audit satisfies CampaignAuditView[],
    };
  }

  // ───────────────────────────── lifecycle ──────────────────────────────

  /**
   * Makes `versionNumber` the version the engine evaluates. On a DRAFT this
   * is the first activation (DRAFT → ACTIVE); on an ACTIVE campaign it swaps
   * the running rule for a newer immutable one; on a PAUSED campaign it swaps
   * and resumes. Every path writes VERSION_ACTIVATED, and the status change,
   * when there is one, its own row.
   */
  async activateVersion(campaignId: string, versionNumber: number, actorId: string) {
    await runSerializable(
      this.prisma,
      async (tx) => {
        const campaign = await this.lockCampaign(tx, campaignId);
        if (campaign.status === CampaignStatus.ENDED) {
          throw invalidTransition(campaign.status, CampaignStatus.ACTIVE);
        }
        await this.requireEngineEnabled(tx);

        const version = await tx.campaignVersion.findUnique({
          where: { campaignId_versionNumber: { campaignId, versionNumber } },
          select: { ...versionSelect, definition: true },
        });
        if (!version) {
          throw versionNotFound();
        }

        await this.judgeActivation(tx, campaign, version, new Date());

        const previous = campaign.activeVersion;
        const becomesActive = campaign.status !== CampaignStatus.ACTIVE;
        await tx.campaign.update({
          where: { id: campaignId },
          data: { activeVersionId: version.id, status: CampaignStatus.ACTIVE },
          select: { id: true },
        });
        await tx.campaignAuditLog.create({
          data: {
            campaignId,
            action: CampaignAuditAction.VERSION_ACTIVATED,
            campaignVersionId: version.id,
            actorId,
            summary: {
              versionNumber: version.versionNumber,
              previousActiveVersionNumber: previous?.versionNumber ?? null,
              trigger: version.trigger,
              benefitCredits: version.benefitCredits,
              benefitExpiresInDays: version.benefitExpiresInDays,
              maxRedemptionsPerProvider: version.maxRedemptionsPerProvider,
            },
          },
        });
        if (becomesActive) {
          await tx.campaignAuditLog.create({
            data: {
              campaignId,
              action:
                campaign.status === CampaignStatus.PAUSED ? CampaignAuditAction.RESUMED : CampaignAuditAction.ACTIVATED,
              campaignVersionId: version.id,
              actorId,
              summary: { versionNumber: version.versionNumber },
            },
          });
        }
      },
      { label: 'campaigns.activateVersion' },
    );

    return this.getForAdmin(campaignId);
  }

  /** ACTIVE → PAUSED. Always possible; grants nothing; existing lots keep working (CMP-001 §2.1). */
  async pause(campaignId: string, reason: string, actorId: string) {
    await this.transition(campaignId, CampaignStatus.PAUSED, reason, actorId);
    return this.getForAdmin(campaignId);
  }

  /** PAUSED → ACTIVE, with the same engine switch and the same activation gate as a first activation. */
  async resume(campaignId: string, reason: string, actorId: string) {
    await this.transition(campaignId, CampaignStatus.ACTIVE, reason, actorId);
    return this.getForAdmin(campaignId);
  }

  /** ACTIVE/PAUSED → ENDED. Terminal; always possible. */
  async end(campaignId: string, reason: string, actorId: string) {
    await this.transition(campaignId, CampaignStatus.ENDED, reason, actorId);
    return this.getForAdmin(campaignId);
  }

  private async transition(campaignId: string, to: CampaignStatus, reason: string, actorId: string) {
    const trimmed = reason.trim();
    await runSerializable(
      this.prisma,
      async (tx) => {
        const campaign = await this.lockCampaign(tx, campaignId);
        const allowed = TRANSITIONS[campaign.status]?.includes(to) ?? false;
        if (!allowed) {
          throw invalidTransition(campaign.status, to);
        }
        if (to === CampaignStatus.ACTIVE) {
          // A resumption is an activation of the version already on the
          // campaign: same switch, same gate, judged again now.
          await this.requireEngineEnabled(tx);
          if (!campaign.activeVersion) {
            throw invalidTransition(campaign.status, to);
          }
          await this.judgeActivation(tx, campaign, campaign.activeVersion, new Date());
        }
        await tx.campaign.update({ where: { id: campaignId }, data: { status: to }, select: { id: true } });
        await tx.campaignAuditLog.create({
          data: {
            campaignId,
            action: TRANSITION_ACTIONS[to]!,
            campaignVersionId: campaign.activeVersionId,
            actorId,
            summary: { reason: trimmed, versionNumber: campaign.activeVersion?.versionNumber ?? null },
          },
        });
      },
      { label: `campaigns.${to.toLowerCase()}` },
    );
  }

  /**
   * The campaign row's lock and its current state, in one statement (the
   * same device `addVersion` uses): a second operator acting on the same
   * campaign waits here and, once the first commit lands, is replayed by
   * `runSerializable` rather than deciding from a stale status.
   */
  private async lockCampaign(tx: Prisma.TransactionClient, campaignId: string) {
    return tx.campaign
      .update({
        where: { id: campaignId },
        data: { updatedAt: new Date() },
        select: {
          id: true,
          status: true,
          activeVersionId: true,
          redemptionCount: true,
          budgetConsumedCredits: true,
          activeVersion: { select: { ...versionSelect, definition: true } },
        },
      })
      .catch((error: unknown) => {
        if (isRecordMissing(error)) {
          throw campaignNotFound();
        }
        throw error;
      });
  }

  /**
   * Read on the transaction's own connection, so the answer is the one the
   * engine would give inside the same snapshot. Off means no activation and
   * no resumption — and nothing written: this runs before any write.
   */
  private async requireEngineEnabled(tx: Prisma.TransactionClient) {
    const row = await tx.operationsSettings.findUnique({
      where: { id: OPERATIONS_SETTINGS_ID },
      select: { campaignEngineEnabled: true },
    });
    if (row?.campaignEngineEnabled !== true) {
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: CAMPAIGN_ENGINE_DISABLED,
        message: 'Kampanya motoru kapalı; etkinleştirme ve devam ettirme yapılamaz.',
      });
    }
  }

  /**
   * The activation gate (CMP-001 §8.4, §10.4; S2B2 brief). Every check is a
   * read; the first refusal list that is not empty ends the transaction with
   * 400 CAMPAIGN_ACTIVATION_REFUSED and nothing written.
   */
  private async judgeActivation(
    tx: Prisma.TransactionClient,
    campaign: { id: string; redemptionCount: number; budgetConsumedCredits: number },
    version: VersionRow & { definition: Prisma.JsonValue },
    now: Date,
  ) {
    const errors: CampaignActivationError[] = [];

    // 1. The stored definition, through today's validator and catalogue.
    const validated = await this.validate(version.definition);
    if (!validated.ok) {
      errors.push(...validated.errors);
      throw activationRefused(errors);
    }
    const definition = validated.definition;

    // 2. The window must not have closed already.
    if (version.windowEndAt !== null && version.windowEndAt <= now) {
      errors.push({
        path: 'window.endAt',
        code: 'WINDOW_INVALID',
        message: `${CAMPAIGN_RULE_ERROR_MESSAGES.WINDOW_INVALID} Pencere kapanmış bir sürüm etkinleştirilemez.`,
      });
    }

    // 3. Every fact source the version depends on needs a booted PROVIDER writer.
    for (const { path, source } of requiredFactSources(definition)) {
      if (!this.factSources.hasProviderWriter(source)) {
        errors.push({
          path,
          code: 'FACT_SOURCE_UNAVAILABLE',
          message: `${CAMPAIGN_ACTIVATION_ERROR_MESSAGES.FACT_SOURCE_UNAVAILABLE} (${source})`,
        });
      }
    }

    // 4. Limits against what the campaign has already consumed, cumulative
    //    across versions. Equal is allowed (no further grant, nothing wrong);
    //    below is refused.
    const below = (path: string, limit: number, consumed: number) => {
      errors.push({
        path,
        code: 'LIMIT_BELOW_CONSUMED',
        message: `${CAMPAIGN_ACTIVATION_ERROR_MESSAGES.LIMIT_BELOW_CONSUMED} (limit ${limit}, tüketilen ${consumed})`,
      });
    };
    if (version.maxRedemptionsGlobal !== null && version.maxRedemptionsGlobal < campaign.redemptionCount) {
      below('limits.maxRedemptionsGlobal', version.maxRedemptionsGlobal, campaign.redemptionCount);
    }
    if (version.budgetCredits !== null && version.budgetCredits < campaign.budgetConsumedCredits) {
      below('limits.budgetCredits', version.budgetCredits, campaign.budgetConsumedCredits);
    }
    const perProvider = await tx.campaignProviderCounter.aggregate({
      where: { campaignId: campaign.id },
      _max: { redemptionCount: true },
    });
    const mostByOneProvider = perProvider._max.redemptionCount ?? 0;
    if (version.maxRedemptionsPerProvider < mostByOneProvider) {
      below('limits.maxRedemptionsPerProvider', version.maxRedemptionsPerProvider, mostByOneProvider);
    }
    if (version.maxRedemptionsPerDay !== null) {
      const today = await tx.campaignDailyCounter.findUnique({
        where: { campaignId_day: { campaignId: campaign.id, day: istanbulDay(now) } },
        select: { redemptionCount: true },
      });
      const consumedToday = today?.redemptionCount ?? 0;
      if (version.maxRedemptionsPerDay < consumedToday) {
        below('limits.maxRedemptionsPerDay', version.maxRedemptionsPerDay, consumedToday);
      }
    }

    if (errors.length > 0) {
      throw activationRefused(errors);
    }
  }
}

/** Allowed lifecycle moves (CMP-001 §2.1). Absent status → no move. */
const TRANSITIONS: Readonly<Partial<Record<CampaignStatus, readonly CampaignStatus[]>>> = {
  ACTIVE: [CampaignStatus.PAUSED, CampaignStatus.ENDED],
  PAUSED: [CampaignStatus.ACTIVE, CampaignStatus.ENDED],
};

const TRANSITION_ACTIONS: Readonly<Partial<Record<CampaignStatus, CampaignAuditAction>>> = {
  ACTIVE: CampaignAuditAction.RESUMED,
  PAUSED: CampaignAuditAction.PAUSED,
  ENDED: CampaignAuditAction.ENDED,
};

/**
 * Which registered writers a definition depends on: its trigger's source,
 * every eligibility fact, and every proof condition it names.
 */
function requiredFactSources(definition: CampaignDefinition): Array<{ path: string; source: CampaignFactSource }> {
  const required: Array<{ path: string; source: CampaignFactSource }> = [];
  if (definition.trigger === 'PROVIDER_APPROVED' || definition.trigger === 'PACKAGE_PAYMENT_SUCCEEDED') {
    required.push({ path: 'trigger', source: definition.trigger });
  }
  // The validator admitted only catalogue facts, which are the enum's values.
  (definition.eligibility?.facts ?? []).forEach((fact, index) => {
    required.push({ path: `eligibility.facts[${index}]`, source: fact as CampaignEligibilityFact });
  });
  definition.conditions.all.forEach((entry, index) => {
    if (isAnyGroup(entry)) {
      entry.any.forEach((condition, inner) => {
        const source = CONDITION_FACT_SOURCES[condition.type];
        if (source) required.push({ path: `conditions.all[${index}].any[${inner}]`, source });
      });
      return;
    }
    const source = CONDITION_FACT_SOURCES[entry.type];
    if (source) required.push({ path: `conditions.all[${index}]`, source });
  });
  return required;
}

// ────────────────────────────── helpers ───────────────────────────────

function campaignView(row: CampaignRow): CampaignView {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    status: row.status,
    activeVersionId: row.activeVersionId,
    redemptionCount: row.redemptionCount,
    budgetConsumedCredits: row.budgetConsumedCredits,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy,
  };
}

function versionSummaryView(row: VersionRow): CampaignVersionSummaryView {
  const { definition: _definition, ...summary } = row;
  return summary;
}

/**
 * The stored JSON is re-parsed on the way out (CMP-001 §2.2): what the panel
 * sees is what the validator accepts today, not whatever the column holds.
 */
function versionView(row: VersionRow): CampaignVersionView {
  const parsed = validateCampaignDefinition(row.definition);
  return {
    ...versionSummaryView(row),
    definition: parsed.ok ? parsed.definition : (row.definition as unknown as CampaignDefinition),
  };
}

function changedFields(previous: Prisma.JsonValue | null, next: CampaignDefinition): string[] {
  if (previous === null || typeof previous !== 'object' || Array.isArray(previous)) {
    return [];
  }
  const before = previous as Record<string, unknown>;
  return DEFINITION_FIELDS.filter(
    (field) => stableStringify(before[field] ?? null) !== stableStringify(next[field] ?? null),
  );
}

/** JSON with object keys sorted, so a jsonb round trip (which reorders keys) compares equal. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function definitionInvalid(errors: CampaignRuleError[]) {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code: CAMPAIGN_DEFINITION_INVALID,
    message: 'Kampanya tanımı doğrulamadan geçmedi.',
    errors,
  });
}

function keyTaken() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: CAMPAIGN_KEY_TAKEN,
    message: 'Bu anahtar başka bir kampanyada kullanılıyor.',
  });
}

function campaignNotFound() {
  return new NotFoundException({
    statusCode: HttpStatus.NOT_FOUND,
    error: 'Not Found',
    code: CAMPAIGN_NOT_FOUND,
    message: 'Kampanya bulunamadı.',
  });
}

function versionNotFound() {
  return new NotFoundException({
    statusCode: HttpStatus.NOT_FOUND,
    error: 'Not Found',
    code: CAMPAIGN_VERSION_NOT_FOUND,
    message: 'Kampanya sürümü bulunamadı.',
  });
}

function campaignEnded() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: CAMPAIGN_ENDED,
    message: 'Sona ermiş bir kampanyaya revizyon eklenemez.',
  });
}

function invalidTransition(from: CampaignStatus, to: CampaignStatus) {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: CAMPAIGN_INVALID_TRANSITION,
    message: `Kampanya ${from} durumundan ${to} durumuna geçemez.`,
    from,
    to,
  });
}

function activationRefused(errors: CampaignActivationError[]) {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code: CAMPAIGN_ACTIVATION_REFUSED,
    message: 'Sürüm etkinleştirilemedi.',
    errors,
  });
}

function isRecordMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2025'
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
