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
  type CampaignRedemptionStatus,
  type CampaignRevokeReason,
  CampaignStatus,
  CampaignTriggerEventStatus,
  Prisma,
  type CampaignBenefitType,
  type CampaignEligibilityFact,
  type CampaignEvaluationOutcome,
  type CampaignStackPolicy,
  type CampaignTrigger,
  type PromoCreditLotStatus,
} from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { OPERATIONS_SETTINGS_ID } from '../operations-settings/operations-settings.service';
import { CampaignEngineSettingsService } from './campaign-engine-settings.service';
import { CAMPAIGN_LIST_DEFAULT_LIMIT } from './dto/list-campaigns.dto';
import { istanbulDay } from './engine/campaign-engine.repository';
import { CampaignRevokeService } from './engine/campaign-revoke.service';
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
 * 5. The operations desk (CMP-003 S3) reads a campaign's redemptions and the
 *    events its running rule is a candidate for; it revokes one named
 *    redemption through `CampaignRevokeService` — the path a payment
 *    reversal takes — and it can put a parked event back in the worker's
 *    queue. Neither write evaluates a rule or grants a credit.
 */

export const CAMPAIGN_DEFINITION_INVALID = 'CAMPAIGN_DEFINITION_INVALID';
export const CAMPAIGN_KEY_TAKEN = 'CAMPAIGN_KEY_TAKEN';
export const CAMPAIGN_NOT_FOUND = 'CAMPAIGN_NOT_FOUND';
export const CAMPAIGN_VERSION_NOT_FOUND = 'CAMPAIGN_VERSION_NOT_FOUND';
export const CAMPAIGN_ENDED = 'CAMPAIGN_ENDED';
export const CAMPAIGN_INVALID_TRANSITION = 'CAMPAIGN_INVALID_TRANSITION';
export const CAMPAIGN_ENGINE_DISABLED = 'CAMPAIGN_ENGINE_DISABLED';
export const CAMPAIGN_ACTIVATION_REFUSED = 'CAMPAIGN_ACTIVATION_REFUSED';
export const CAMPAIGN_REDEMPTION_NOT_FOUND = 'CAMPAIGN_REDEMPTION_NOT_FOUND';
export const CAMPAIGN_REDEMPTION_NOT_REVOCABLE = 'CAMPAIGN_REDEMPTION_NOT_REVOCABLE';
export const CAMPAIGN_EVENT_NOT_FOUND = 'CAMPAIGN_EVENT_NOT_FOUND';
export const CAMPAIGN_EVENT_NOT_RETRYABLE = 'CAMPAIGN_EVENT_NOT_RETRYABLE';

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
  /** CMP-003 S3: revokes per UTC day before an automatic pause; null = no threshold. */
  maxRevokesPerDay: number | null;
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

/**
 * The evaluation queue, read-only (S2B2 rev. 2): how many raised events are
 * waiting, being worked, or parked after a failure, and the last closed
 * error code. Global, not per campaign — an event is a candidate of every
 * ACTIVE campaign that answers its trigger. No route acts on it.
 */
export type CampaignEvaluationQueueView = {
  pending: number;
  processing: number;
  retryWait: number;
  lastErrorCode: string | null;
  lastErrorAt: Date | null;
};

export type CampaignValidationView = {
  valid: boolean;
  errors: CampaignRuleError[];
  summary: CampaignDefinitionSummary | null;
};

/**
 * One redemption as the operations desk sees it (CMP-003 S3): ids, the
 * frozen version number, amounts, the lot's state and the revoke record.
 * The provider is named by its business identity only — no contact detail,
 * no account, no token, no rules snapshot.
 */
export type CampaignRedemptionView = {
  id: string;
  status: CampaignRedemptionStatus;
  versionNumber: number;
  trigger: CampaignTrigger;
  triggerEventKey: string;
  provider: { id: string; businessName: string };
  purchaseId: string | null;
  grantedCredits: number;
  grantedAt: Date;
  grantTransactionId: string | null;
  lot: { id: string; status: PromoCreditLotStatus; remainingCredits: number; expiresAt: Date } | null;
  revokedAt: Date | null;
  revokeReason: CampaignRevokeReason | null;
  spentAtRevoke: number | null;
  /** grantedCredits − spentAtRevoke on a revoked row; null otherwise. */
  revokedCredits: number | null;
  revokedBy: ActorView | null;
  revokeNote: string | null;
  revokedByWebhookEventId: string | null;
};

/** One event the campaign's running rule is a candidate for, with its queue state. */
export type CampaignEvaluationEventView = {
  id: string;
  triggerEventKey: string;
  trigger: CampaignTrigger;
  providerId: string;
  purchaseId: string | null;
  status: CampaignTriggerEventStatus;
  attemptCount: number;
  evaluationCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  nextAttemptAt: Date;
  leaseUntil: Date | null;
  lastErrorCode: string | null;
  lastErrorAt: Date | null;
  settledByCampaignId: string | null;
  settledAt: Date | null;
  /** The newest evaluation log row of this event for this campaign. */
  lastOutcome: { outcome: CampaignEvaluationOutcome; reasonCode: string | null; evaluatedAt: Date } | null;
  /** RETRY_WAIT, or PROCESSING under a lease that has lapsed: what the retry route accepts. */
  retryable: boolean;
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
  maxRevokesPerDay: true,
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
    @Inject(CampaignRevokeService) private readonly revokes: CampaignRevokeService,
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
        maxRevokesPerDay: definition.limits.maxRevokesPerDay,
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
    const [engineEnabled, evaluationQueue, rows] = await Promise.all([
      this.engineSettings.isEngineEnabled(),
      this.evaluationQueue(),
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
      evaluationQueue,
      items: page.map((row) => ({
        ...campaignView(row),
        currentVersion: row.currentVersion ? versionSummaryView(row.currentVersion) : null,
        activeVersion: row.activeVersion ? versionSummaryView(row.activeVersion) : null,
      })),
      nextCursor: rows.length > take ? page[page.length - 1]!.id : null,
    };
  }

  async getForAdmin(campaignId: string) {
    const [engineEnabled, evaluationQueue, row] = await Promise.all([
      this.engineSettings.isEngineEnabled(),
      this.evaluationQueue(),
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
      evaluationQueue,
      campaign: campaignView(row),
      currentVersion: row.currentVersion ? versionView(row.currentVersion) : null,
      activeVersion: row.activeVersion ? versionView(row.activeVersion) : null,
      versions: versions.map(versionView),
      audit: audit satisfies CampaignAuditView[],
    };
  }

  private async evaluationQueue(): Promise<CampaignEvaluationQueueView> {
    const [counts, lastError] = await Promise.all([
      this.prisma.campaignTriggerEvent.groupBy({
        by: ['status'],
        where: { status: { in: ['PENDING', 'PROCESSING', 'RETRY_WAIT'] } },
        _count: { _all: true },
      }),
      this.prisma.campaignTriggerEvent.findFirst({
        where: { lastErrorCode: { not: null } },
        orderBy: [{ lastErrorAt: 'desc' }, { id: 'desc' }],
        select: { lastErrorCode: true, lastErrorAt: true },
      }),
    ]);
    const count = (status: string) => counts.find((entry) => entry.status === status)?._count._all ?? 0;
    return {
      pending: count('PENDING'),
      processing: count('PROCESSING'),
      retryWait: count('RETRY_WAIT'),
      lastErrorCode: lastError?.lastErrorCode ?? null,
      lastErrorAt: lastError?.lastErrorAt ?? null,
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
          currentVersion: { select: { trigger: true, factSetKey: true } },
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

  // ───────────────────── operations desk (CMP-003 S3) ─────────────────────

  async listRedemptions(campaignId: string, query: { limit?: number; cursor?: string }) {
    await this.requireCampaign(campaignId);
    const take = query.limit ?? CAMPAIGN_LIST_DEFAULT_LIMIT;
    const rows = await this.prisma.campaignRedemption.findMany({
      where: { campaignId },
      orderBy: [{ grantedAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: redemptionSelect,
    });
    const page = rows.slice(0, take);
    return {
      items: page.map(redemptionView),
      nextCursor: rows.length > take ? page[page.length - 1]!.id : null,
    };
  }

  /**
   * The events this campaign's rule answers: same trigger and, on the
   * eligibility transition, the same fact set. The rule is the running
   * version, or the latest stored one while nothing runs yet. The queue
   * itself is global; this is the slice of it an operator looking at one
   * campaign can act on.
   */
  async listEvaluationEvents(campaignId: string, query: { limit?: number; cursor?: string }) {
    const campaign = await this.requireCampaign(campaignId);
    const rule = campaign.activeVersion ?? campaign.currentVersion;
    if (!rule) {
      return { items: [] as CampaignEvaluationEventView[], nextCursor: null };
    }
    const take = query.limit ?? CAMPAIGN_LIST_DEFAULT_LIMIT;
    const now = new Date();
    const rows = await this.prisma.campaignTriggerEvent.findMany({
      where: { trigger: rule.trigger, factSetKey: rule.factSetKey },
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: eventSelect,
    });
    const page = rows.slice(0, take);
    const logs = await this.prisma.campaignEvaluationLog.findMany({
      where: { campaignId, triggerEventId: { in: page.map((row) => row.id) } },
      orderBy: [{ evaluatedAt: 'desc' }, { id: 'desc' }],
      select: { triggerEventId: true, outcome: true, reasonCode: true, evaluatedAt: true },
    });
    const lastOutcome = new Map<string, CampaignEvaluationEventView['lastOutcome']>();
    for (const log of logs) {
      if (!lastOutcome.has(log.triggerEventId)) {
        lastOutcome.set(log.triggerEventId, { outcome: log.outcome, reasonCode: log.reasonCode, evaluatedAt: log.evaluatedAt });
      }
    }
    return {
      items: page.map((row) => eventView(row, lastOutcome.get(row.id) ?? null, now)),
      nextCursor: rows.length > take ? page[page.length - 1]!.id : null,
    };
  }

  /**
   * Revokes one GRANTED redemption of this campaign with the operator's
   * reason — through `CampaignRevokeService`, so the ledger row, the lot,
   * the redemption, the daily counter and the threshold behave exactly as
   * they do for a payment reversal — and records REDEMPTION_REVOKED. A
   * redemption that is not this campaign's is 404; one that is not GRANTED
   * (already revoked, or expired) is 409, and nothing is written.
   */
  async revokeRedemption(campaignId: string, redemptionId: string, reason: string, actorId: string) {
    const note = reason.trim();
    await runSerializable(
      this.prisma,
      async (tx) => {
        const campaign = await this.lockCampaign(tx, campaignId);
        const redemption = await tx.campaignRedemption.findUnique({
          where: { id: redemptionId },
          select: { id: true, campaignId: true, status: true, campaignVersion: { select: { id: true, versionNumber: true } } },
        });
        if (!redemption || redemption.campaignId !== campaign.id) {
          throw redemptionNotFound();
        }
        if (redemption.status !== 'GRANTED') {
          throw redemptionNotRevocable(redemption.status);
        }
        const now = new Date();
        const outcome = await this.revokes.revokeRedemption(tx, { redemptionId, actorId, note, now });
        if (!outcome) {
          throw redemptionNotRevocable(redemption.status);
        }
        await tx.campaignAuditLog.create({
          data: {
            campaignId,
            action: CampaignAuditAction.REDEMPTION_REVOKED,
            campaignVersionId: redemption.campaignVersion.id,
            actorId,
            summary: {
              redemptionId,
              versionNumber: redemption.campaignVersion.versionNumber,
              revokedCredits: outcome.revokedCredits,
              spentAtRevoke: outcome.spentAtRevoke,
              revokeCountToday: outcome.revokeCountToday,
              autoPaused: outcome.autoPaused,
              reason: note,
            },
          },
        });
      },
      { label: 'campaigns.revokeRedemption' },
    );
    return this.getForAdmin(campaignId);
  }

  /**
   * Puts a parked event back at the front of the worker's queue: RETRY_WAIT,
   * or PROCESSING under a lease that has lapsed, becomes RETRY_WAIT due now
   * with no lease. Nothing is evaluated and nothing is granted here — the
   * worker claims the event on its next tick, which is also why the route is
   * refused while the engine is off (the worker would never come). A
   * SETTLED, EVALUATED, PENDING or live-leased event is refused untouched;
   * `lastErrorCode` is kept so the operator still sees why it was parked.
   */
  async retryEvaluationEvent(campaignId: string, eventId: string, actorId: string): Promise<CampaignEvaluationEventView> {
    return runSerializable(
      this.prisma,
      async (tx) => {
        await this.requireEngineEnabled(tx);
        const campaign = await this.lockCampaign(tx, campaignId);
        const rule = campaign.activeVersion ?? campaign.currentVersion;
        const event = await tx.campaignTriggerEvent.findUnique({ where: { id: eventId }, select: eventSelect });
        if (!event || !rule || event.trigger !== rule.trigger || event.factSetKey !== rule.factSetKey) {
          throw eventNotFound();
        }
        const now = new Date();
        const released = await tx.campaignTriggerEvent.updateMany({
          where: {
            id: eventId,
            OR: [
              { status: CampaignTriggerEventStatus.RETRY_WAIT },
              { status: CampaignTriggerEventStatus.PROCESSING, leaseUntil: { lt: now } },
            ],
          },
          data: { status: CampaignTriggerEventStatus.RETRY_WAIT, nextAttemptAt: now, leaseUntil: null },
        });
        if (released.count !== 1) {
          throw eventNotRetryable(event.status);
        }
        await tx.campaignAuditLog.create({
          data: {
            campaignId,
            action: CampaignAuditAction.EVENT_RETRY_REQUESTED,
            campaignVersionId: campaign.activeVersionId,
            actorId,
            summary: {
              triggerEventId: event.id,
              triggerEventKey: event.triggerEventKey,
              previousStatus: event.status,
              attemptCount: event.attemptCount,
              lastErrorCode: event.lastErrorCode,
            },
          },
        });
        const updated = await tx.campaignTriggerEvent.findUniqueOrThrow({ where: { id: eventId }, select: eventSelect });
        return eventView(updated, null, now);
      },
      { label: 'campaigns.retryEvaluationEvent' },
    );
  }

  private async requireCampaign(campaignId: string) {
    const row = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true,
        activeVersion: { select: { trigger: true, factSetKey: true } },
        currentVersion: { select: { trigger: true, factSetKey: true } },
      },
    });
    if (!row) {
      throw campaignNotFound();
    }
    return row;
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

const redemptionSelect = {
  id: true,
  status: true,
  trigger: true,
  triggerEventKey: true,
  purchaseId: true,
  grantedCredits: true,
  grantedAt: true,
  grantTransactionId: true,
  revokedAt: true,
  revokeReason: true,
  spentAtRevoke: true,
  revokeNote: true,
  revokedByWebhookEventId: true,
  campaignVersion: { select: { versionNumber: true } },
  provider: { select: { id: true, businessName: true } },
  promoLot: { select: { id: true, status: true, remainingCredits: true, expiresAt: true } },
  revokedBy: actorSelect,
} satisfies Prisma.CampaignRedemptionSelect;

type RedemptionRow = Prisma.CampaignRedemptionGetPayload<{ select: typeof redemptionSelect }>;

function redemptionView(row: RedemptionRow): CampaignRedemptionView {
  return {
    id: row.id,
    status: row.status,
    versionNumber: row.campaignVersion.versionNumber,
    trigger: row.trigger,
    triggerEventKey: row.triggerEventKey,
    provider: row.provider,
    purchaseId: row.purchaseId,
    grantedCredits: row.grantedCredits,
    grantedAt: row.grantedAt,
    grantTransactionId: row.grantTransactionId,
    lot: row.promoLot,
    revokedAt: row.revokedAt,
    revokeReason: row.revokeReason,
    spentAtRevoke: row.spentAtRevoke,
    revokedCredits: row.spentAtRevoke === null ? null : row.grantedCredits - row.spentAtRevoke,
    revokedBy: row.revokedBy,
    revokeNote: row.revokeNote,
    revokedByWebhookEventId: row.revokedByWebhookEventId,
  };
}

const eventSelect = {
  id: true,
  triggerEventKey: true,
  trigger: true,
  factSetKey: true,
  providerId: true,
  purchaseId: true,
  status: true,
  attemptCount: true,
  evaluationCount: true,
  firstSeenAt: true,
  lastSeenAt: true,
  nextAttemptAt: true,
  leaseUntil: true,
  lastErrorCode: true,
  lastErrorAt: true,
  settledByCampaignId: true,
  settledAt: true,
} satisfies Prisma.CampaignTriggerEventSelect;

type EventRow = Prisma.CampaignTriggerEventGetPayload<{ select: typeof eventSelect }>;

function isRetryable(row: Pick<EventRow, 'status' | 'leaseUntil'>, now: Date): boolean {
  return (
    row.status === CampaignTriggerEventStatus.RETRY_WAIT ||
    (row.status === CampaignTriggerEventStatus.PROCESSING && row.leaseUntil !== null && row.leaseUntil < now)
  );
}

function eventView(row: EventRow, lastOutcome: CampaignEvaluationEventView['lastOutcome'], now: Date): CampaignEvaluationEventView {
  const { factSetKey: _factSetKey, ...rest } = row;
  return { ...rest, lastOutcome, retryable: isRetryable(row, now) };
}

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
  // The stored JSON is normalised through today's validator before the
  // comparison, so an optional field the catalogue gained since that version
  // was saved (absent there, explicit null in `next`) does not report a change
  // the operator did not make.
  const parsed = validateCampaignDefinition(previous);
  const before = (parsed.ok ? parsed.definition : previous) as Record<string, unknown>;
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

function redemptionNotFound() {
  return new NotFoundException({
    statusCode: HttpStatus.NOT_FOUND,
    error: 'Not Found',
    code: CAMPAIGN_REDEMPTION_NOT_FOUND,
    message: 'Bu kampanyaya ait böyle bir hak ediş yok.',
  });
}

function redemptionNotRevocable(status: CampaignRedemptionStatus) {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: CAMPAIGN_REDEMPTION_NOT_REVOCABLE,
    message: `Hak ediş ${status} durumunda; yalnızca GRANTED durumundaki hak ediş geri alınabilir.`,
    status,
  });
}

function eventNotFound() {
  return new NotFoundException({
    statusCode: HttpStatus.NOT_FOUND,
    error: 'Not Found',
    code: CAMPAIGN_EVENT_NOT_FOUND,
    message: 'Bu kampanyanın kuralına aday olan böyle bir olay yok.',
  });
}

function eventNotRetryable(status: CampaignTriggerEventStatus) {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: CAMPAIGN_EVENT_NOT_RETRYABLE,
    message: `Olay ${status} durumunda; yalnızca yeniden deneme bekleyen ya da sahipliği düşmüş olaylar kuyruğa alınabilir.`,
    status,
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
