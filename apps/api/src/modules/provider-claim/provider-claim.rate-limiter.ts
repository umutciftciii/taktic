import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PROVIDER_CLAIM_MAX_SENDS_PER_IP_PER_HOUR,
  PROVIDER_CLAIM_MAX_SENDS_PER_PROVIDER_PER_HOUR,
  PROVIDER_CLAIM_RATE_WINDOW_MINUTES,
} from './provider-claim.config';
import { claimRateLimitedException } from './provider-claim.errors';

/**
 * Two send budgets for claim invitations, both raising the same 429.
 *
 * The per-application budget is counted from ProviderClaimToken rows, so it
 * survives a restart and cannot be reset by reconnecting. The per-address one
 * is an in-memory window, exactly like the credential throttle: it exists to
 * bound a burst, and storing a client address on every issued token to make it
 * durable would put an identifier into a table that currently holds none.
 *
 * The address budget is charged before the application budget is read, so
 * tripping the cheaper limit does not buy free attempts at the other one. Both
 * failures are indistinguishable to the caller — see claimRateLimitedException.
 */
@Injectable()
export class ProviderClaimRateLimiter {
  private readonly windowMs = PROVIDER_CLAIM_RATE_WINDOW_MINUTES * 60 * 1000;
  private readonly hitsByClient = new Map<string, number[]>();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Charges both budgets for one invitation attempt, or throws.
   *
   * `ipAddress` may be null — a caller the server could not attribute is put in
   * one shared bucket rather than being waved through.
   */
  async assertWithinBudgets(providerId: string, ipAddress: string | null): Promise<void> {
    this.chargeClientBudget(ipAddress ?? 'unknown');
    await this.assertProviderBudget(providerId);
  }

  /** Drops every recorded window. Test seam; nothing in the app calls it. */
  reset(): void {
    this.hitsByClient.clear();
  }

  private chargeClientBudget(client: string): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hitsByClient.get(client) ?? []).filter((at) => at > cutoff);

    if (recent.length >= PROVIDER_CLAIM_MAX_SENDS_PER_IP_PER_HOUR) {
      // Written back so the pruned window is kept: an attempt that is refused
      // must not also clear the record of the attempts that refused it.
      this.hitsByClient.set(client, recent);
      throw claimRateLimitedException();
    }

    recent.push(now);
    this.hitsByClient.set(client, recent);
  }

  private async assertProviderBudget(providerId: string): Promise<void> {
    const issued = await this.prisma.providerClaimToken.count({
      where: {
        providerId,
        createdAt: { gt: new Date(Date.now() - this.windowMs) },
      },
    });

    if (issued >= PROVIDER_CLAIM_MAX_SENDS_PER_PROVIDER_PER_HOUR) {
      throw claimRateLimitedException();
    }
  }
}
