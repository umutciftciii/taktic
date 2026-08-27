import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  COMPANY_SETTINGS_ID,
  type CompanySettingsIssue,
} from '../company-settings/company-settings.service';
import {
  isDeliverableSupportEmail,
  isPublishableCompanyName,
} from '../company-settings/company-settings.rules';
import {
  CompanyBrandingValues,
  EmailBranding,
  developmentBranding,
  emailLogoUrl,
  readDeprecatedEnvBranding,
} from './email-branding.config';
import { isDeliveringEmailTransportConfigured } from './email-transport';

/**
 * Resolves the footer at send time, and says no when it cannot.
 *
 * Three sources, in order: the admin-managed settings row, then the deprecated
 * environment variables (so a deployment that already had them keeps working
 * while its operator moves the values into the panel), then — for a transport
 * that delivers nothing — the obviously-fake development placeholders.
 *
 * The rule that matters is the last one. A transport that puts a message in a
 * stranger's inbox gets no placeholders and no partial footer: if the legal name
 * or the support address is missing, or the support address is one nobody could
 * ever write to, this returns `complete: false` and the caller refuses the send.
 * That refusal is deliberately louder than a bad footer is quiet — a customer
 * who receives an e-mail telling them to write to `destek@example.test` has no
 * way to know it is wrong, whereas a FAILED row with a named cause is exactly
 * what an operator can act on.
 *
 * Read on every send rather than cached. An operator who has just fixed the
 * footer expects the next message to carry it, and the query is one indexed
 * primary-key lookup.
 */

export type EmailBrandingResolution =
  | { complete: true; branding: EmailBranding }
  | { complete: false; issues: CompanySettingsIssue[] };

@Injectable()
export class EmailBrandingService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async resolve(): Promise<EmailBrandingResolution> {
    const values = await this.readValues();

    // Console and the recording outbox deliver to nobody, so a preview may show
    // the placeholder footer — that is what makes it recognisable as a preview.
    if (!isDeliveringEmailTransportConfigured()) {
      const fallback = developmentBranding();

      return {
        complete: true,
        branding: {
          supportEmail: values.supportEmail ?? fallback.supportEmail,
          companyName: values.legalName ?? fallback.companyName,
          companyAddress: values.postalAddress,
          logoUrl: fallback.logoUrl,
        },
      };
    }

    const issues = publishingIssues(values);
    if (issues.length > 0) {
      return { complete: false, issues };
    }

    return {
      complete: true,
      branding: {
        // Non-null by construction: `publishingIssues` reported nothing.
        supportEmail: values.supportEmail as string,
        companyName: values.legalName as string,
        companyAddress: values.postalAddress,
        logoUrl: emailLogoUrl(),
      },
    };
  }

  /** The settings row if there is one, otherwise the deprecated variables. */
  private async readValues(): Promise<CompanyBrandingValues> {
    const row = await this.prisma.companySettings.findUnique({
      where: { id: COMPANY_SETTINGS_ID },
      select: { legalName: true, supportEmail: true, postalAddress: true },
    });

    if (!row) {
      return readDeprecatedEnvBranding();
    }

    return {
      legalName: row.legalName.trim() || null,
      supportEmail: row.supportEmail.trim() || null,
      postalAddress: row.postalAddress?.trim() || null,
    };
  }
}

/**
 * Why these values may not be printed in a delivered footer.
 *
 * The same predicates the admin screen reports with, so the panel's warning and
 * the transport's refusal can never disagree. The postal address is never a
 * reason: it is optional by design and the footer simply drops the line.
 */
export function publishingIssues(values: CompanyBrandingValues): CompanySettingsIssue[] {
  if (!values.legalName && !values.supportEmail) {
    return ['NOT_CONFIGURED'];
  }

  const issues: CompanySettingsIssue[] = [];

  if (!values.legalName || !isPublishableCompanyName(values.legalName)) {
    issues.push('LEGAL_NAME_MISSING');
  }

  if (!values.supportEmail) {
    issues.push('SUPPORT_EMAIL_MISSING');
  } else if (!isDeliverableSupportEmail(values.supportEmail)) {
    issues.push('SUPPORT_EMAIL_NOT_DELIVERABLE');
  }

  return issues;
}
