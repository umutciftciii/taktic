import { Inject, Injectable } from '@nestjs/common';
import { ShowcaseCardStatus, ShowcaseVersionReview } from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { ListShowcaseCardsDto, ListShowcaseVersionsDto } from './dto/review-showcase-version.dto';
import {
  showcaseCardNotFound,
  showcaseVersionNotFound,
  showcaseVersionNotPending,
} from './showcase.errors';
import {
  showcaseCardInclude,
  showcaseVersionInclude,
  toShowcaseCard,
  toShowcaseVersion,
} from './showcase.projection';

/**
 * The operator's side of vitrin: the queue, one version at a time, and the two
 * decisions that can be made about it.
 *
 * ## What an operator may not do here
 *
 * There is no create, no edit and no delete. An operator reviews what a provider
 * wrote; they do not write it. A route that let an operator fix a typo would
 * make `ShowcaseCardReview` a record of somebody approving their own text, and
 * would put words in a business's mouth about its own price.
 *
 * There is also no route that moves a version backwards. A decided version stays
 * decided: the provider's next attempt is the next version, which keeps the
 * refused text and the reason for its refusal intact.
 *
 * ## Why both decisions are serializable
 *
 * Each one writes three rows that have to agree — the version's status, the
 * card's pointers, and the review that justifies both. Two operators opening the
 * same queue entry is the ordinary case, not the exotic one, and the loser has
 * to be told rather than silently overwriting the winner's decision. Three
 * things stop that: the transaction, the conditional update inside it, and the
 * unique index on `ShowcaseCardReview.cardVersionId`.
 */
@Injectable()
export class AdminShowcaseService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * The review queue. Defaults to what is actually waiting.
   *
   * Oldest submission first: a queue that showed the newest first would leave
   * the provider who has waited longest at the bottom of the operator's screen.
   */
  async listVersions(filters: ListShowcaseVersionsDto) {
    const versions = await this.prisma.showcaseCardVersion.findMany({
      where: {
        reviewStatus: filters.reviewStatus ?? ShowcaseVersionReview.PENDING,
        ...(filters.providerId ? { card: { providerId: filters.providerId } } : {}),
      },
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      include: {
        ...showcaseVersionInclude,
        card: {
          include: {
            ...showcaseCardInclude,
            provider: { select: { id: true, businessName: true, status: true } },
          },
        },
      },
    });

    return versions.map((version) => ({
      ...toShowcaseVersion(version),
      card: toShowcaseCard(version.card),
      provider: version.card.provider,
    }));
  }

  /**
   * One version, with everything an operator needs to decide about it: the text,
   * the areas, the card it belongs to, and the business behind it.
   *
   * The provider block is the one thing this projection carries that the
   * provider's own screen does not — an operator judging a claim about
   * "İstanbul/Kadıköy" needs to see whose claim it is.
   */
  async getVersion(versionId: string) {
    const version = await this.prisma.showcaseCardVersion.findUnique({
      where: { id: versionId },
      include: {
        ...showcaseVersionInclude,
        card: {
          include: {
            ...showcaseCardInclude,
            provider: {
              select: {
                id: true,
                businessName: true,
                contactName: true,
                status: true,
                city: true,
                district: true,
                serviceAreas: {
                  select: { scope: true, city: true, district: true, neighborhood: true },
                },
              },
            },
          },
        },
        autoPublishAudit: {
          select: { id: true, previousVersionId: true, removedAreaKeys: true, createdAt: true },
        },
      },
    });

    if (!version) {
      throw showcaseVersionNotFound();
    }

    return {
      ...toShowcaseVersion(version),
      card: toShowcaseCard(version.card),
      provider: version.card.provider,
      autoPublish: version.autoPublishAudit,
    };
  }

  async listCards(filters: ListShowcaseCardsDto) {
    const cards = await this.prisma.showcaseCard.findMany({
      where: {
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.providerId ? { providerId: filters.providerId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        ...showcaseCardInclude,
        provider: { select: { id: true, businessName: true, status: true } },
      },
    });

    return cards.map((card) => ({ ...toShowcaseCard(card), provider: card.provider }));
  }

  async getCard(cardId: string) {
    const card = await this.prisma.showcaseCard.findUnique({
      where: { id: cardId },
      include: {
        ...showcaseCardInclude,
        provider: { select: { id: true, businessName: true, contactName: true, status: true } },
        versions: {
          orderBy: [{ versionNumber: 'desc' }],
          include: showcaseVersionInclude,
        },
      },
    });

    if (!card) {
      throw showcaseCardNotFound();
    }

    return {
      ...toShowcaseCard(card),
      provider: card.provider,
      versions: card.versions.map(toShowcaseVersion),
    };
  }

  /**
   * Approval: this version becomes the one the card serves.
   *
   * `draftVersionId` is cleared in the same statement that sets `liveVersionId`.
   * The card is not "approved and still drafting" for any instant a reader could
   * observe, and the next edit starts from the version that is now live rather
   * than from the one that just stopped being a draft.
   */
  async approveVersion(versionId: string, user: AuthUser) {
    await runSerializable(this.prisma, async (tx) => {
      const version = await tx.showcaseCardVersion.findUnique({
        where: { id: versionId },
        select: { id: true, cardId: true, reviewStatus: true },
      });

      if (!version) {
        throw showcaseVersionNotFound();
      }

      const moved = await tx.showcaseCardVersion.updateMany({
        where: { id: versionId, reviewStatus: ShowcaseVersionReview.PENDING },
        data: { reviewStatus: ShowcaseVersionReview.APPROVED, publishedAt: new Date() },
      });

      if (moved.count !== 1) {
        throw showcaseVersionNotPending();
      }

      await tx.showcaseCard.update({
        where: { id: version.cardId },
        data: {
          liveVersionId: versionId,
          draftVersionId: null,
          status: ShowcaseCardStatus.APPROVED,
        },
      });

      await tx.showcaseCardReview.create({
        data: {
          cardVersionId: versionId,
          decision: ShowcaseVersionReview.APPROVED,
          reviewedById: user.id,
          // Explicitly null: the CHECK refuses a note on an approval, because a
          // note there would be an operator's remark travelling on a row the
          // provider's own screen renders.
          note: null,
        },
      });
    }, { label: 'showcase.approveVersion' });

    return this.getVersion(versionId);
  }

  /**
   * Rejection: the version is refused and the card is left exactly as it was.
   *
   * The second half is the part worth stating. A card that already serves an
   * approved version keeps serving it — `liveVersionId` is not touched and the
   * status stays APPROVED — so refusing a provider's new text never takes their
   * working card off the air. Only a card that has never had a live version
   * becomes REJECTED, because for that one there is nothing else it could be.
   */
  async rejectVersion(versionId: string, user: AuthUser, note: string) {
    await runSerializable(this.prisma, async (tx) => {
      const version = await tx.showcaseCardVersion.findUnique({
        where: { id: versionId },
        select: {
          id: true,
          cardId: true,
          reviewStatus: true,
          card: { select: { liveVersionId: true } },
        },
      });

      if (!version) {
        throw showcaseVersionNotFound();
      }

      const moved = await tx.showcaseCardVersion.updateMany({
        where: { id: versionId, reviewStatus: ShowcaseVersionReview.PENDING },
        data: { reviewStatus: ShowcaseVersionReview.REJECTED },
      });

      if (moved.count !== 1) {
        throw showcaseVersionNotPending();
      }

      await tx.showcaseCard.update({
        where: { id: version.cardId },
        data: {
          draftVersionId: null,
          status: version.card.liveVersionId
            ? ShowcaseCardStatus.APPROVED
            : ShowcaseCardStatus.REJECTED,
        },
      });

      await tx.showcaseCardReview.create({
        data: {
          cardVersionId: versionId,
          decision: ShowcaseVersionReview.REJECTED,
          reviewedById: user.id,
          note: note.trim(),
        },
      });
    }, { label: 'showcase.rejectVersion' });

    return this.getVersion(versionId);
  }
}
