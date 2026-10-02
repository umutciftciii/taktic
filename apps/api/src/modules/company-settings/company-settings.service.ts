import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AdminAuditEntry,
  AdminAuditPage,
  AUDIT_ORDER,
  AuditPageQueryDto,
  auditPage,
  auditPaging,
  diffAuditFields,
  readAuditChanges,
  toAuditActor,
  toAuditJson,
} from '../../common/admin-audit';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { staffActorSelect } from '../auth/embedded-permissions';
import { SaveCompanySettingsDto } from './dto/save-company-settings.dto';
import { isDeliverableSupportEmail, isPublishableCompanyName } from './company-settings.rules';

/**
 * The single row, read and written.
 *
 * The id is a constant. Every write is an upsert on it, so "create" and
 * "update" are the same operation from the caller's side and two operators
 * saving at once produce one row rather than a race. The database refuses any
 * other id (see the CHECK constraint in the migration), which is what makes the
 * singleton a guarantee rather than a habit.
 *
 * This service knows nothing about e-mail. It stores three business facts and
 * reports whether they are complete enough to publish; deciding what a missing
 * footer means for a send is the notifications module's job.
 */

export const COMPANY_SETTINGS_ID = 'singleton';

const settingsSelect = {
  legalName: true,
  supportEmail: true,
  postalAddress: true,
  createdAt: true,
  updatedAt: true,
  updatedBy: { select: { id: true, name: true, email: true } },
} satisfies Prisma.CompanySettingsSelect;

export type CompanySettingsRow = Prisma.CompanySettingsGetPayload<{
  select: typeof settingsSelect;
}>;

/** What the admin screen renders: the values, and what is still wrong with them. */
export type CompanySettingsView = {
  configured: boolean;
  legalName: string | null;
  supportEmail: string | null;
  postalAddress: string | null;
  updatedAt: Date | null;
  updatedBy: { id: string; name: string | null } | null;
  /**
   * Machine-readable reasons this row cannot be published in a footer, in the
   * same vocabulary the send path uses. Empty means a delivering transport
   * would compose a complete message from it.
   */
  issues: CompanySettingsIssue[];
};

export const COMPANY_SETTINGS_ISSUES = [
  'NOT_CONFIGURED',
  'LEGAL_NAME_MISSING',
  'SUPPORT_EMAIL_MISSING',
  'SUPPORT_EMAIL_NOT_DELIVERABLE',
] as const;

export type CompanySettingsIssue = (typeof COMPANY_SETTINGS_ISSUES)[number];

@Injectable()
export class CompanySettingsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** The raw row, or null when no operator has saved one yet. */
  read(): Promise<CompanySettingsRow | null> {
    return this.prisma.companySettings.findUnique({
      where: { id: COMPANY_SETTINGS_ID },
      select: settingsSelect,
    });
  }

  async getForAdmin(): Promise<CompanySettingsView> {
    return toView(await this.read());
  }

  /**
   * Writes the row and returns what the screen should now show.
   *
   * `actorId` is the acting operator. It is recorded rather than trusted from
   * the payload — the caller passes the authenticated user.
   *
   * ADMIN-ACTION-AUDIT-001: the save reads the stored values inside the same
   * serializable transaction, writes only when one of the three fields
   * actually differs, and records exactly those fields old → new in
   * CompanySettingsChange. A save that changes nothing writes nothing — not
   * the row (so `updatedBy` keeps naming whoever last changed it) and not an
   * audit row.
   */
  async save(dto: SaveCompanySettingsDto, actorId: string): Promise<CompanySettingsView> {
    const next = {
      legalName: dto.legalName,
      supportEmail: dto.supportEmail,
      postalAddress: dto.postalAddress ?? null,
    };

    await runSerializable(
      this.prisma,
      async (tx) => {
        const current = await tx.companySettings.findUnique({
          where: { id: COMPANY_SETTINGS_ID },
          select: { legalName: true, supportEmail: true, postalAddress: true },
        });
        const changes = diffAuditFields(current, next, COMPANY_SETTINGS_AUDIT_FIELDS);
        if (changes.length === 0) {
          return;
        }

        const data = { ...next, updatedById: actorId };
        await tx.companySettings.upsert({
          where: { id: COMPANY_SETTINGS_ID },
          create: { id: COMPANY_SETTINGS_ID, ...data },
          update: data,
        });
        await tx.companySettingsChange.create({
          data: { changes: toAuditJson(changes), actorId },
          select: { id: true },
        });
      },
      { label: 'companySettings.save' },
    );

    return this.getForAdmin();
  }

  /** The recorded saves, newest first, each with only the fields it changed. */
  async listChanges(query: AuditPageQueryDto | undefined, viewer: AuthUser): Promise<AdminAuditPage> {
    const { page, pageSize, skip } = auditPaging(query);
    const [total, rows] = await Promise.all([
      this.prisma.companySettingsChange.count(),
      this.prisma.companySettingsChange.findMany({
        orderBy: [...AUDIT_ORDER],
        skip,
        take: pageSize,
        select: { id: true, changes: true, createdAt: true, actor: staffActorSelect(viewer) },
      }),
    ]);
    const items = rows.map(
      (row): AdminAuditEntry => ({
        id: row.id,
        domain: 'COMPANY_SETTINGS',
        action: 'UPDATED',
        actor: toAuditActor(row.actor),
        target: { type: 'COMPANY_SETTINGS', id: COMPANY_SETTINGS_ID },
        changes: readAuditChanges(row.changes),
        reason: null,
        createdAt: row.createdAt,
      }),
    );
    return auditPage(items, total, page, pageSize);
  }
}

/** The three business facts, and nothing technical (no transport, key or sender). */
export const COMPANY_SETTINGS_AUDIT_FIELDS = ['legalName', 'supportEmail', 'postalAddress'] as const;

/**
 * Turns a row — or its absence — into the screen's view, including why it is
 * not publishable. The reasons are computed here rather than on the client so
 * the admin panel and the send path can never disagree about what "complete"
 * means.
 */
export function toView(row: CompanySettingsRow | null): CompanySettingsView {
  if (!row) {
    return {
      configured: false,
      legalName: null,
      supportEmail: null,
      postalAddress: null,
      updatedAt: null,
      updatedBy: null,
      issues: ['NOT_CONFIGURED'],
    };
  }

  const issues: CompanySettingsIssue[] = [];

  if (!isPublishableCompanyName(row.legalName)) {
    issues.push('LEGAL_NAME_MISSING');
  }

  if (!row.supportEmail.trim()) {
    issues.push('SUPPORT_EMAIL_MISSING');
  } else if (!isDeliverableSupportEmail(row.supportEmail)) {
    issues.push('SUPPORT_EMAIL_NOT_DELIVERABLE');
  }

  return {
    configured: true,
    legalName: row.legalName,
    supportEmail: row.supportEmail,
    postalAddress: row.postalAddress,
    updatedAt: row.updatedAt,
    // The operator's address is not part of the answer: this endpoint is about
    // the company's public details, and who edited them is an id and a name.
    updatedBy: row.updatedBy ? { id: row.updatedBy.id, name: row.updatedBy.name } : null,
    issues,
  };
}
