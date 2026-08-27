import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
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
   * `updatedById` is the acting operator. It is recorded rather than trusted
   * from the payload — the caller passes the authenticated user, and the column
   * is SetNull so removing that account later does not delete the settings.
   */
  async save(dto: SaveCompanySettingsDto, updatedById: string | null): Promise<CompanySettingsView> {
    const data = {
      legalName: dto.legalName,
      supportEmail: dto.supportEmail,
      postalAddress: dto.postalAddress ?? null,
      updatedById,
    };

    await this.prisma.companySettings.upsert({
      where: { id: COMPANY_SETTINGS_ID },
      create: { id: COMPANY_SETTINGS_ID, ...data },
      update: data,
    });

    return this.getForAdmin();
  }
}

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
