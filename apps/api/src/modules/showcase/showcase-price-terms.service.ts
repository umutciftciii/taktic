import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * The operator's view of who agreed to which price-responsibility text.
 *
 * ## Two tables, one ledger
 *
 * There are two kinds of acceptance row, from two eras of the sale, and both
 * are records of consent that stay exactly as they were written:
 *
 * - `ShowcaseCardPriceTermsAcceptance` — keyed to a *card*, from the card-bound
 *   sale. No route writes one any more; the rows are what every legacy run was
 *   sold under, and what its public card still shows.
 * - `ShowcasePackageTermsAcceptance` — keyed to the *business* and a version,
 *   written by the package-first checkout the first time a provider buys under
 *   a given version of the terms.
 *
 * The operator asks one historical question — "what did this business agree
 * to, and when" — and the answer has to cover both, so this merges them and
 * labels each row with its `scope`.
 *
 * ## Append-only
 *
 * There is no update and no delete here, and there is no admin route that
 * writes one either. A record of consent that can be edited afterwards is not a
 * record of consent.
 */
@Injectable()
export class ShowcasePriceTermsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Every version ever accepted, not just the one in force: a list narrowed to
   * today's terms would make the table's whole reason for existing invisible.
   *
   * `cardId` applies to the card-bound rows only; a package-bound acceptance
   * names no card, so a list filtered by card is by definition card-bound.
   */
  async listForAdmin(filters: { providerId?: string; cardId?: string; termsVersion?: string }) {
    const where = {
      ...(filters.providerId ? { providerId: filters.providerId } : {}),
      ...(filters.termsVersion ? { termsVersion: filters.termsVersion } : {}),
    };

    const [cardBound, packageBound] = await Promise.all([
      this.prisma.showcaseCardPriceTermsAcceptance.findMany({
        where: { ...where, ...(filters.cardId ? { cardId: filters.cardId } : {}) },
        orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }],
        take: 200,
        select: cardAcceptanceSelect,
      }),
      filters.cardId
        ? []
        : this.prisma.showcasePackageTermsAcceptance.findMany({
            where,
            orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }],
            take: 200,
            select: packageAcceptanceSelect,
          }),
    ]);

    const acceptances = [
      ...cardBound.map((row) => ({ ...row, scope: 'CARD' as const })),
      ...packageBound.map((row) => ({ ...row, cardId: null, card: null, scope: 'PACKAGE' as const })),
    ].sort((a, b) => b.acceptedAt.getTime() - a.acceptedAt.getTime());

    return { acceptances };
  }
}

const cardAcceptanceSelect = {
  id: true,
  cardId: true,
  providerId: true,
  termsVersion: true,
  termsTextSnapshot: true,
  acceptedAt: true,
  provider: { select: { id: true, businessName: true, status: true } },
  card: { select: { id: true, kind: true, status: true, categoryId: true } },
  acceptedByUser: { select: { id: true, name: true, email: true } },
} satisfies Prisma.ShowcaseCardPriceTermsAcceptanceSelect;

const packageAcceptanceSelect = {
  id: true,
  providerId: true,
  termsVersion: true,
  termsTextSnapshot: true,
  acceptedAt: true,
  provider: { select: { id: true, businessName: true, status: true } },
  acceptedByUser: { select: { id: true, name: true, email: true } },
} satisfies Prisma.ShowcasePackageTermsAcceptanceSelect;
