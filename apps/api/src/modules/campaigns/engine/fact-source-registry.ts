import { Injectable, Logger } from '@nestjs/common';
import { CampaignEligibilityFact, type Prisma, ProviderStatus, SourceChannel, UserRole } from '@prisma/client';

/**
 * The allow-list of status facts an eligibility transition may name, each
 * with its one canonical read (CMP-001 §8.2), plus the register of the code
 * points that write them.
 *
 * `readAll` never trusts the caller: when a writer reports "EMAIL_VERIFIED
 * just became true", the engine re-reads every fact of every set that names
 * it, from the columns that *are* the fact — `ProviderProfile.status`,
 * `User.emailVerifiedAt`, `User.phoneVerifiedAt` through `ProviderProfile.userId`
 * (a guest application has no account, so its account facts read false).
 *
 * The writer register is filled at boot by the services that own the writes
 * (CMP-002 S2B2): `ProvidersService` for PROVIDER_APPROVED,
 * `EmailVerificationService` for EMAIL_VERIFIED, `PhoneVerificationService`
 * for PHONE_VERIFIED, and the two settlement paths — the Lemon Squeezy
 * webhook and the mock adapter — for PACKAGE_PAYMENT_SUCCEEDED. Each of them
 * calls `CampaignEngineHooks` from inside the transaction that persists the
 * write, and registers itself in `onModuleInit`, so an entry here means "a
 * booted module is calling the hook", not "somebody once wrote a comment".
 * A version that names a source with no PROVIDER-role writer cannot be
 * activated (§8.4, `FACT_SOURCE_UNAVAILABLE`); that gate is mechanical.
 *
 * CMP-006 PR-D adds the channel capability beside it: which *source channel*
 * a booted module stamps on the events of a source, derived on the server —
 * `ProvidersService` and `ProviderInvitesService` write WEB applications
 * (PROVIDER_APPROVED), `PackagePurchasesService` writes WEB purchases
 * (PACKAGE_PAYMENT_SUCCEEDED), `EmailVerificationService` and
 * `PhoneVerificationService` confirm WEB proofs (EMAIL_VERIFIED,
 * PHONE_VERIFIED). A version targeting WEB or MOBILE cannot be activated
 * unless every source it depends on has a registered producer of that
 * channel (`CHANNEL_SOURCE_UNAVAILABLE`). Nothing registers MOBILE: there is
 * no mobile client, and a label no server can derive is not a source.
 */

/** Everything a version may depend on that some writer has to raise. */
export type CampaignFactSource = CampaignEligibilityFact | 'PACKAGE_PAYMENT_SUCCEEDED';

export type FactWriter = { module: string; role: UserRole };

/** A channel a writer can stamp on an event. UNKNOWN is what nobody vouches for, so it is never registered. */
export type RegistrableChannel = Exclude<SourceChannel, 'UNKNOWN'>;

export type ChannelProducer = { module: string };

const factSelect = {
  status: true,
  user: { select: { emailVerifiedAt: true, phoneVerifiedAt: true } },
} satisfies Prisma.ProviderProfileSelect;

type FactRow = Prisma.ProviderProfileGetPayload<{ select: typeof factSelect }>;

@Injectable()
export class FactSourceRegistry {
  private readonly logger = new Logger(FactSourceRegistry.name);

  readonly facts: readonly CampaignEligibilityFact[] = Object.values(CampaignEligibilityFact);

  private readonly writers = new Map<CampaignFactSource, FactWriter[]>();

  private readonly channels = new Map<string, ChannelProducer[]>();

  /** Records that `writer` raises `source` through the engine hooks. Idempotent per (source, module, role). */
  register(source: CampaignFactSource, writer: FactWriter): void {
    const list = this.writers.get(source) ?? [];
    if (!list.some((entry) => entry.module === writer.module && entry.role === writer.role)) {
      list.push(writer);
      this.writers.set(source, list);
      this.logger.log(`Campaign fact source ${source} has writer ${writer.module} (${writer.role})`);
    }
  }

  /** True when a PROVIDER-role writer of this source is registered. */
  hasProviderWriter(source: CampaignFactSource): boolean {
    return (this.writers.get(source) ?? []).some((writer) => writer.role === UserRole.PROVIDER);
  }

  /** The register, read-only, for the activation gate's error detail and for tests. */
  writersOf(source: CampaignFactSource): readonly FactWriter[] {
    return this.writers.get(source) ?? [];
  }

  /**
   * Records that `producer` derives `channel`, on the server, for the events
   * of `source`. Idempotent per (source, channel, module).
   */
  registerChannel(source: CampaignFactSource, channel: RegistrableChannel, producer: ChannelProducer): void {
    if ((channel as SourceChannel) === SourceChannel.UNKNOWN) {
      throw new Error('UNKNOWN is not a channel a module can vouch for');
    }
    const key = channelKey(source, channel);
    const list = this.channels.get(key) ?? [];
    if (!list.some((entry) => entry.module === producer.module)) {
      list.push(producer);
      this.channels.set(key, list);
      this.logger.log(`Campaign fact source ${source} has ${channel} channel producer ${producer.module}`);
    }
  }

  /** True when some booted module stamps `channel` on events of `source`. */
  hasChannelProducer(source: CampaignFactSource, channel: RegistrableChannel): boolean {
    return (this.channels.get(channelKey(source, channel)) ?? []).length > 0;
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

function channelKey(source: CampaignFactSource, channel: RegistrableChannel): string {
  return `${source}|${channel}`;
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
