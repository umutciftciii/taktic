import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { providerInviteUrl } from '../../common/web-routes';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { canBeAssignedByAdmin } from '../categories/category-taxonomy';
import { ProvidersService } from '../providers/providers.service';
import { SubmitProviderInviteApplicationDto } from './dto/submit-provider-invite-application.dto';
import {
  activeProviderInviteFilter,
  PROVIDER_INVITE_TOKEN_BYTES,
  PROVIDER_INVITE_TTL_MS,
  providerInviteState,
  type ProviderInviteState,
} from './provider-invites.constants';
import {
  providerInviteAlreadyUsedException,
  providerInviteCategoryNotInvitableException,
  providerInviteNotFoundException,
} from './provider-invites.errors';

/**
 * Same construction as every other single-use token in this codebase: sha256 of
 * the raw value, and only the digest is ever written down.
 */
function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

function generateRawToken(): string {
  return randomBytes(PROVIDER_INVITE_TOKEN_BYTES).toString('base64url');
}

/** What an admin list row says. Note what is absent: the token, and its hash. */
export type ProviderInviteSummary = {
  id: string;
  state: ProviderInviteState;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  createdBy: { id: string; name: string | null } | null;
};

/**
 * The one response in the whole system that carries a raw token.
 *
 * It exists because the platform does not mail this link — an operator hands it
 * over themselves — so there has to be exactly one moment at which the link is
 * legible, and this is it. Everything else about the invitation is readable
 * forever; the URL is readable once, in the response to the request that
 * created it, and never again from any endpoint.
 */
export type IssuedProviderInvite = ProviderInviteSummary & {
  /** Contains the raw token. Returned once, at creation, and never re-read. */
  url: string;
};

const inviteSummarySelect = {
  id: true,
  createdAt: true,
  expiresAt: true,
  usedAt: true,
  revokedAt: true,
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.ProviderInviteTokenSelect;

@Injectable()
export class ProviderInvitesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProvidersService) private readonly providers: ProvidersService,
  ) {}

  /**
   * Issues a link for one category.
   *
   * Several may be live for the same category at once, deliberately. This is a
   * recruiting link, not a key to one account: an operator approaching five
   * businesses about the same draft service needs five links, and each one has
   * to die on its own when it is used. Issuing one therefore closes nothing —
   * which is the opposite of the claim flow, where at most one link per
   * application may ever live.
   */
  async issueForCategory(categoryId: string, actor: AuthUser): Promise<IssuedProviderInvite> {
    const category = await this.prisma.serviceCategory.findUnique({
      where: { id: categoryId },
      select: { id: true, kind: true, status: true },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    // The same rule that decides whether an operator may bind a provider to a
    // category by hand, and for the same reason: an invitation is that binding
    // with the application still to be written. Reusing the predicate rather
    // than restating it is what keeps the two from drifting into different
    // answers to "may this category have providers behind it yet".
    if (!canBeAssignedByAdmin(category)) {
      throw providerInviteCategoryNotInvitableException();
    }

    const rawToken = generateRawToken();

    const invite = await this.prisma.providerInviteToken.create({
      data: {
        categoryId: category.id,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + PROVIDER_INVITE_TTL_MS),
        createdById: actor.id,
      },
      select: inviteSummarySelect,
    });

    return { ...toSummary(invite), url: providerInviteUrl(rawToken) };
  }

  /**
   * Every invitation ever issued for a category, newest first.
   *
   * The whole history rather than the live ones: an operator asking "did we
   * already approach somebody about this service" is asking about the spent and
   * withdrawn rows as much as the live ones. No row carries a token or a URL —
   * see {@link IssuedProviderInvite} for the single place one does.
   */
  async listForCategory(categoryId: string): Promise<{
    categoryId: string;
    activeCount: number;
    invites: ProviderInviteSummary[];
  }> {
    await this.ensureCategoryExists(categoryId);

    const invites = await this.prisma.providerInviteToken.findMany({
      where: { categoryId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: inviteSummarySelect,
    });

    const summaries = invites.map((invite) => toSummary(invite));

    return {
      categoryId,
      activeCount: summaries.filter((invite) => invite.state === 'ACTIVE').length,
      invites: summaries,
    };
  }

  /**
   * Withdraws a link that has not been used.
   *
   * Conditional on `usedAt: null` rather than read-then-write, so revoking a
   * link at the moment somebody is submitting through it cannot produce a row
   * that is both used and revoked. Of the two, whichever commits first wins and
   * the other is told plainly what happened: the operator sees the invitation
   * as USED, the applicant's submission succeeded.
   *
   * Revoking an already-revoked link is a completed request, not a failure —
   * `revoked` says which of the two happened. Revoking an expired one is
   * allowed and does nothing observable, because a link that already died of
   * the clock is not a link anybody can use.
   */
  async revoke(
    categoryId: string,
    inviteId: string,
  ): Promise<{ revoked: boolean; invite: ProviderInviteSummary }> {
    await this.ensureCategoryExists(categoryId);

    // Scoped by category as well as by id: the route says which category is
    // being administered, and an id from another one must read as "no such
    // invitation here" rather than quietly acting on a different service.
    const existing = await this.prisma.providerInviteToken.findFirst({
      where: { id: inviteId, categoryId },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException('Provider invite not found');
    }

    const { count } = await this.prisma.providerInviteToken.updateMany({
      where: { id: inviteId, categoryId, usedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const invite = await this.prisma.providerInviteToken.findUniqueOrThrow({
      where: { id: inviteId },
      select: inviteSummarySelect,
    });

    return { revoked: count === 1, invite: toSummary(invite) };
  }

  /**
   * Reads a link without spending it: everything the public screen may show.
   *
   * That is the category's *name* and the expiry, and nothing else. Not the
   * description, not the question set, not the price, not who else is behind
   * it, not the slug, not the id — a DRAFT category's catalogue entry is the
   * unreleased product, and the holder of a link has been told about one
   * service, not shown the roadmap.
   */
  async describeInvite(rawToken: string): Promise<{
    valid: true;
    categoryName: string;
    expiresAt: Date;
  }> {
    const invite = await this.resolveLiveInvite(this.prisma, rawToken);

    return {
      valid: true as const,
      categoryName: invite.category.name,
      expiresAt: invite.expiresAt,
    };
  }

  /**
   * Spends the link and records the application behind it.
   *
   * One transaction, and the consume is its first statement. Two things follow
   * from that order. The conditional UPDATE takes the row lock before any of
   * the application work happens, so of two simultaneous submissions the loser
   * finds out immediately instead of after writing a profile it then has to
   * roll back; and there is no window in which an application exists against an
   * invitation still marked unused, which is a link that could be redeemed
   * twice.
   *
   * Read-committed rather than Serializable on purpose. The whole race is one
   * row, and a conditional UPDATE on one row is exactly what read-committed
   * resolves deterministically: the second writer blocks, re-reads the
   * committed row, matches nothing and is told so. Under Serializable it would
   * instead be rolled back as a write conflict and retried, and the retry would
   * re-resolve the now-spent token into the public 404 — which is the wrong
   * answer for somebody whose link *was* live when they pressed the button.
   *
   * The category binding comes from the invitation. The client is not asked
   * (see SubmitProviderInviteApplicationDto) and could not be believed if it
   * were.
   */
  async submitApplication(
    dto: SubmitProviderInviteApplicationDto,
    user: AuthUser | null,
    meta: { ipAddress?: string | null; userAgent?: string | null } = {},
  ): Promise<{ success: true }> {
    const { token, ...application } = dto;

    // Resolved before the transaction so a dead or unknown link is refused with
    // the same 404 the read-only route gives, without a transaction ever being
    // opened for it. From here on "the link stopped being live" is a race, and
    // gets the 409 that says so.
    const invite = await this.resolveLiveInvite(this.prisma, token);

    // Outside the transaction too: this reads the category table and the
    // location tables, and holding a row lock across those reads would widen
    // the conflict window for nothing. Its refusals are the guest form's own —
    // a customer account, an account that already owns a profile, an
    // unreachable address, an invalid province.
    const payload = await this.providers.prepareApplication(application, user, [
      invite.category.id,
    ]);

    const providerId = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const consumed = await tx.providerInviteToken.updateMany({
        // The same predicate the readiness count filters on, so "live" means
        // one thing across the whole feature.
        where: { id: invite.id, ...activeProviderInviteFilter(now) },
        data: { usedAt: now },
      });

      if (consumed.count !== 1) {
        throw providerInviteAlreadyUsedException();
      }

      const provider = await this.providers.createApplicationRecord(tx, payload, user);

      return provider.id;
    });

    // After the commit, and best-effort: the receipt and — while the claim flow
    // is on — the link that hands this application to whoever submitted it. A
    // dead transport must not undo an application that is already stored.
    await this.providers.announceNewApplication(providerId, user, meta);

    // Deliberately no provider record, no id and no category in the response.
    // The applicant has just filled the form in; there is nothing here they do
    // not already know, and every field this did return would be a field a
    // future change could accidentally widen into the draft catalogue.
    return { success: true as const };
  }

  /**
   * The single place that decides whether a link may be acted on.
   *
   * Both the read-only route and the submission go through it, so a screen can
   * never offer a form the submission would then refuse. Every failure it can
   * produce is the same 404: unknown token, spent, revoked, expired, and a
   * category that has since stopped being invitable.
   */
  private async resolveLiveInvite(
    client: Pick<Prisma.TransactionClient, 'providerInviteToken'>,
    rawToken: string,
  ) {
    const trimmed = rawToken.trim();

    if (!trimmed) {
      throw providerInviteNotFoundException();
    }

    const invite = await client.providerInviteToken.findUnique({
      where: { tokenHash: hashToken(trimmed) },
      select: {
        id: true,
        expiresAt: true,
        usedAt: true,
        revokedAt: true,
        category: { select: { id: true, name: true, kind: true, status: true } },
      },
    });

    if (!invite || providerInviteState(invite) !== 'ACTIVE') {
      throw providerInviteNotFoundException();
    }

    // The category is re-checked on every use rather than trusted from issue
    // time, because its status moves underneath the link. A draft that was
    // closed must stop accepting applications immediately — the marketplace has
    // said it is not selling this — while a draft that was *released* keeps
    // working, since ACTIVE is the state the invitation was preparing for. That
    // asymmetry is not special-cased here: it falls out of reusing the same
    // predicate the issuing route uses.
    if (!canBeAssignedByAdmin(invite.category)) {
      throw providerInviteNotFoundException();
    }

    return invite;
  }

  private async ensureCategoryExists(categoryId: string): Promise<void> {
    const category = await this.prisma.serviceCategory.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }
  }
}

function toSummary(
  invite: Prisma.ProviderInviteTokenGetPayload<{ select: typeof inviteSummarySelect }>,
): ProviderInviteSummary {
  return { ...invite, state: providerInviteState(invite) };
}
