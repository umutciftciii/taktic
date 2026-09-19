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
import { CampaignEngineSettingsService } from './campaign-engine-settings.service';
import { CAMPAIGN_LIST_DEFAULT_LIMIT } from './dto/list-campaigns.dto';
import type { CampaignRuleError } from './rules/errors';
import type { CampaignDefinition, CampaignDefinitionSummary } from './rules/types';
import { collectPackageSlugs, validateCampaignDefinition } from './rules/validator';

/**
 * Campaign definitions and their immutable drafts (CMP-002 S1).
 *
 * Three rules, in the order they are enforced:
 *
 * 1. Validate before write. A definition goes through the rule validator —
 *    with the package catalogue supplied — before any transaction opens; an
 *    invalid one produces a 400 and no row of any kind.
 * 2. Versions are written, never updated. A revision is a new CampaignVersion
 *    with the next number and a move of `Campaign.currentVersionId`, in one
 *    Serializable transaction that first takes the campaign row's lock so two
 *    operators saving at once serialise rather than collide.
 * 3. Nothing here grants anything. There is no activation, no evaluation and
 *    no ledger write; the engine switch is read for a badge and is not
 *    writable through this module.
 */

export const CAMPAIGN_DEFINITION_INVALID = 'CAMPAIGN_DEFINITION_INVALID';
export const CAMPAIGN_KEY_TAKEN = 'CAMPAIGN_KEY_TAKEN';
export const CAMPAIGN_NOT_FOUND = 'CAMPAIGN_NOT_FOUND';
export const CAMPAIGN_NOT_DRAFT = 'CAMPAIGN_NOT_DRAFT';

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
  createdAt: true,
  updatedAt: true,
  createdBy: actorSelect,
  currentVersion: { select: versionSelect },
} satisfies Prisma.CampaignSelect;

type CampaignRow = Prisma.CampaignGetPayload<{ select: typeof campaignSelect }>;

@Injectable()
export class CampaignsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CampaignEngineSettingsService)
    private readonly engineSettings: CampaignEngineSettingsService,
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
        if (campaign.status !== CampaignStatus.DRAFT) {
          throw new ConflictException({
            statusCode: HttpStatus.CONFLICT,
            error: 'Conflict',
            code: CAMPAIGN_NOT_DRAFT,
            message: 'Yalnızca taslak durumundaki kampanyaya revizyon eklenebilir.',
          });
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
      versions: versions.map(versionView),
      audit: audit satisfies CampaignAuditView[],
    };
  }
}

// ────────────────────────────── helpers ───────────────────────────────

function campaignView(row: CampaignRow): CampaignView {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    status: row.status,
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
