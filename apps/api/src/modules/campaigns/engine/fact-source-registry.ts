import { Injectable } from '@nestjs/common';
import { CampaignEligibilityFact, type Prisma, ProviderStatus, UserRole } from '@prisma/client';

/**
 * The allow-list of status facts an eligibility transition may name, each
 * with its one canonical read (CMP-001 §8.2).
 *
 * `read` never trusts the caller: when a writer reports "EMAIL_VERIFIED just
 * became true", the engine re-reads every fact of every set that names it,
 * from the columns that *are* the fact — `ProviderProfile.status`,
 * `User.emailVerifiedAt`, `User.phoneVerifiedAt` through `ProviderProfile.userId`
 * (a guest application has no account, so its account facts read false).
 *
 * `writers` is the register of code points that write a fact and call
 * `onProviderFact`. It is empty in S2A: the PROVIDER-role writers exist
 * (AUTH-PROVIDER-CONTACT-001 left `// CMP-002 fact callback` marks at
 * `providers.service.ts`, `email-verification.service.ts` and
 * `phone-verification.service.ts`) but are not wired, and a version whose
 * fact has no PROVIDER writer cannot be activated (§8.4) — which is the
 * mechanical gate that keeps K1 closed until S2B registers them.
 */

export type FactWriter = { module: string; role: UserRole };

export type FactSource = {
  fact: CampaignEligibilityFact;
  writers: readonly FactWriter[];
};

const SOURCES: Readonly<Record<CampaignEligibilityFact, FactSource>> = {
  PROVIDER_APPROVED: { fact: 'PROVIDER_APPROVED', writers: [] },
  EMAIL_VERIFIED: { fact: 'EMAIL_VERIFIED', writers: [] },
  PHONE_VERIFIED: { fact: 'PHONE_VERIFIED', writers: [] },
};

const factSelect = {
  status: true,
  user: { select: { emailVerifiedAt: true, phoneVerifiedAt: true } },
} satisfies Prisma.ProviderProfileSelect;

type FactRow = Prisma.ProviderProfileGetPayload<{ select: typeof factSelect }>;

@Injectable()
export class FactSourceRegistry {
  readonly facts: readonly CampaignEligibilityFact[] = Object.values(CampaignEligibilityFact);

  /** True when a PROVIDER-role writer of this fact is registered. False for every fact in S2A. */
  hasProviderWriter(fact: CampaignEligibilityFact): boolean {
    return SOURCES[fact].writers.some((writer) => writer.role === UserRole.PROVIDER);
  }

  /**
   * Every fact of `facts` for one provider, from one read of the canonical
   * columns. A missing profile reads as all-false rather than throwing: the
   * engine's answer to "is this provider eligible" is then simply no.
   */
  async readAll(
    tx: Prisma.TransactionClient,
    providerId: string,
    facts: readonly CampaignEligibilityFact[],
  ): Promise<Record<CampaignEligibilityFact, boolean>> {
    const row = await tx.providerProfile.findUnique({ where: { id: providerId }, select: factSelect });
    const result = {} as Record<CampaignEligibilityFact, boolean>;
    for (const fact of facts) {
      result[fact] = row ? holds(fact, row) : false;
    }
    return result;
  }
}

function holds(fact: CampaignEligibilityFact, row: FactRow): boolean {
  switch (fact) {
    case 'PROVIDER_APPROVED':
      return row.status === ProviderStatus.APPROVED;
    case 'EMAIL_VERIFIED':
      return row.user?.emailVerifiedAt != null;
    case 'PHONE_VERIFIED':
      return row.user?.phoneVerifiedAt != null;
  }
}
