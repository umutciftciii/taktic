import { Inject, Injectable } from '@nestjs/common';
import {
  ProviderStatus,
  ShowcaseCardStatus,
  ShowcaseEntitlementStatus,
  ShowcasePlacementSuspendReason,
  ShowcaseVersionChangeTrigger,
  ShowcaseVersionReview,
} from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { TransactionalMailService } from '../notifications/transactional-mail.service';
import { ShowcaseEntitlementService } from './showcase-entitlement.service';
import { ShowcasePlacementService } from './showcase-placement.service';
import { assertCategoryStillOpen, assertVersionAreasCovered } from './showcase-publish-preflight';
import { ListShowcaseCardsDto, ListShowcaseVersionsDto } from './dto/review-showcase-version.dto';
import {
  showcaseCardAlreadySuspended,
  showcaseCardNotFound,
  showcaseCardNotSuspended,
  showcaseEntitlementMissing,
  showcaseProviderNotApproved,
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
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ShowcasePlacementService)
    private readonly placements: ShowcasePlacementService,
    @Inject(ShowcaseEntitlementService)
    private readonly entitlements: ShowcaseEntitlementService,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
  ) {}

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

    // The right this card sits on, if it is waiting for its first approval.
    // An operator deciding a first version needs to see that approving it will
    // spend a right — and which package the run will be. A revision of a live
    // card has no reserved right, and shows none.
    const reserved = await this.prisma.showcaseEntitlement.findFirst({
      where: { cardId: version.cardId, status: ShowcaseEntitlementStatus.RESERVED },
      select: {
        packageNameSnapshot: true,
        durationDaysSnapshot: true,
        expiresAt: true,
        reviewPausedAt: true,
      },
    });
    const now = new Date();

    return {
      ...toShowcaseVersion(version),
      card: toShowcaseCard(version.card),
      provider: version.card.provider,
      autoPublish: version.autoPublishAudit,
      entitlement: reserved
        ? {
            packageName: reserved.packageNameSnapshot,
            durationDays: reserved.durationDaysSnapshot,
            expiresAt: reserved.expiresAt.toISOString(),
            pausedForReview: reserved.reviewPausedAt !== null,
            valid: reserved.reviewPausedAt !== null || reserved.expiresAt > now,
          }
        : null,
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
   *
   * ## The first approval is the publication
   *
   * A card with nothing live is going on the air here. The right it was opened
   * on is spent in this transaction and the placement is born from it, so
   * "approved" and "on the air" are one fact. Which means the three things that
   * have to hold on the air — a valid right, an open shelf, covered areas — are
   * checked here before anything is written; a refusal leaves the version
   * PENDING and the queue as it was. "Approved but unpublishable" cannot be
   * produced.
   *
   * A card with something live is revising it. No right is involved; the run
   * already behind the card is re-pinned to the approved text.
   */
  async approveVersion(versionId: string, user: AuthUser) {
    let activatedPlacementId: string | null = null;

    await runSerializable(this.prisma, async (tx) => {
      const version = await tx.showcaseCardVersion.findUnique({
        where: { id: versionId },
        select: {
          id: true,
          cardId: true,
          reviewStatus: true,
          card: {
            select: {
              id: true,
              providerId: true,
              categoryId: true,
              kind: true,
              liveVersionId: true,
              category: { select: { id: true, kind: true, status: true } },
            },
          },
        },
      });

      if (!version) {
        throw showcaseVersionNotFound();
      }

      if (version.reviewStatus !== ShowcaseVersionReview.PENDING) {
        throw showcaseVersionNotPending();
      }

      const firstPublication = version.card.liveVersionId === null;
      const now = new Date();

      if (firstPublication) {
        const reserved = await this.entitlements.findReservedForCard(tx, version.cardId, now);
        if (!reserved) {
          throw showcaseEntitlementMissing();
        }
        // The same gate `use-entitlement` applies before it publishes: a
        // business that is no longer approved cannot be put on the home page,
        // and the right must not be spent on a run that could not be shown.
        const provider = await tx.providerProfile.findUniqueOrThrow({
          where: { id: version.card.providerId },
          select: { status: true },
        });
        if (provider.status !== ProviderStatus.APPROVED) {
          throw showcaseProviderNotApproved();
        }
        assertCategoryStillOpen(version.card.category, version.card.kind);
        await assertVersionAreasCovered(tx, version.card.providerId, versionId);
      }

      const moved = await tx.showcaseCardVersion.updateMany({
        where: { id: versionId, reviewStatus: ShowcaseVersionReview.PENDING },
        data: { reviewStatus: ShowcaseVersionReview.APPROVED, publishedAt: now },
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

      if (firstPublication) {
        // The right is spent and the run is born, here, on the version that
        // was just approved. `consumeForCard` re-reads the right under the
        // transaction, so a right that vanished between the check above and
        // this line still refuses rather than publishing on nothing.
        const { placementId } = await this.entitlements.consumeForCard(tx, {
          cardId: version.cardId,
          versionId,
          providerId: version.card.providerId,
          categoryId: version.card.categoryId,
          kind: version.card.kind,
          now,
        });
        activatedPlacementId = placementId;
      } else {
        /*
         * Every paid run of this card moves to the text that was just
         * approved, in this same transaction.
         *
         * The operator decided this version should be what the card says. A
         * placement still publishing the previous one would mean the home page
         * and the card's own page disagreeing about the same business — and
         * the home page would be showing text nobody currently stands behind.
         *
         * The shelves are rebuilt from the new version's areas, so an approval
         * that widened coverage widens the run's reach and one that narrowed
         * it narrows it. `endAt` is untouched: re-pinning is a change to what
         * is shown, never to what was bought.
         */
        await this.placements.repinToVersion(
          tx,
          version.cardId,
          versionId,
          ShowcaseVersionChangeTrigger.ADMIN_APPROVAL,
        );
      }
    }, { label: 'showcase.approveVersion' });

    // After the commit: a mail about a run that was rolled back would announce
    // nothing, and the settlement path sends the same message the same way.
    if (activatedPlacementId) {
      await this.mail.sendShowcasePlacementActivated(activatedPlacementId);
    }

    return this.getVersion(versionId);
  }

  /**
   * Takes a card off the air, and every run it is publishing with it.
   *
   * Phase one reserved `SUSPENDED` and left it with no writer, on the grounds
   * that nothing rendered a card to anybody. That is no longer true — this
   * phase puts approved cards on the home page and lets them collect leads —
   * and an operator who cannot pull a card they have already approved would be
   * an operator whose moderation stops mattering the moment somebody pays.
   *
   * The clock **stops** while it is down. This is the platform pulling the
   * card, so the days the provider cannot use are not billed to them; the
   * suspension row records `extendsClock: true` and `resume()` pays them back.
   */
  async suspendCard(cardId: string, user: AuthUser, note: string | null) {
    await runSerializable(
      this.prisma,
      async (tx) => {
        const card = await tx.showcaseCard.findUnique({
          where: { id: cardId },
          select: { id: true, status: true },
        });

        if (!card) {
          throw showcaseCardNotFound();
        }

        if (card.status === ShowcaseCardStatus.SUSPENDED) {
          throw showcaseCardAlreadySuspended();
        }

        await tx.showcaseCard.update({
          where: { id: cardId },
          data: {
            status: ShowcaseCardStatus.SUSPENDED,
            suspendedAt: new Date(),
            suspendReason: note?.trim() || null,
          },
        });

        await this.placements.suspendLiveFor(
          tx,
          { cardId },
          {
            reason: ShowcasePlacementSuspendReason.ADMIN_ACTION,
            actorUserId: user.id,
            note: note?.trim() || null,
          },
        );
      },
      { label: 'showcase.suspendCard' },
    );

    return this.getCard(cardId);
  }

  /**
   * Puts a suspended card back, and resumes what it was publishing.
   *
   * Only an operator can do this, and only for a hold an operator placed —
   * `ADMIN_ACTION` is the one suspension reason that does not lift by itself,
   * because it is a judgement rather than an observable condition.
   *
   * The card returns to APPROVED only when it still has a live version. One
   * that never had one goes back to where it was, which for the only case that
   * can reach here is DRAFT.
   */
  async unsuspendCard(cardId: string) {
    await runSerializable(
      this.prisma,
      async (tx) => {
        const card = await tx.showcaseCard.findUnique({
          where: { id: cardId },
          select: { id: true, status: true, liveVersionId: true },
        });

        if (!card) {
          throw showcaseCardNotFound();
        }

        if (card.status !== ShowcaseCardStatus.SUSPENDED) {
          throw showcaseCardNotSuspended();
        }

        await tx.showcaseCard.update({
          where: { id: cardId },
          data: {
            status: card.liveVersionId
              ? ShowcaseCardStatus.APPROVED
              : ShowcaseCardStatus.DRAFT,
            suspendedAt: null,
            suspendReason: null,
          },
        });

        // Resumed by reason, so lifting an operator's hold cannot accidentally
        // put a card back on a shelf the platform has closed for some other
        // reason.
        const placements = await tx.showcasePlacement.findMany({
          where: {
            cardId,
            status: 'SUSPENDED',
            suspendReason: ShowcasePlacementSuspendReason.ADMIN_ACTION,
          },
          select: { id: true },
        });

        for (const placement of placements) {
          await this.placements.resume(tx, placement.id, {
            expectedReason: ShowcasePlacementSuspendReason.ADMIN_ACTION,
          });
        }
      },
      { label: 'showcase.unsuspendCard' },
    );

    return this.getCard(cardId);
  }

  /**
   * Rejection: the version is refused and the card is left exactly as it was.
   *
   * The second half is the part worth stating. A card that already serves an
   * approved version keeps serving it — `liveVersionId` is not touched and the
   * status stays APPROVED — so refusing a provider's new text never takes their
   * working card off the air. Only a card that has never had a live version
   * becomes REJECTED, because for that one there is nothing else it could be.
   *
   * For that card the right it sits on gets its clock back: the pause opened
   * at submission is closed as REJECTED and the time under review is added to
   * the right's window. The right stays reserved on the card — the provider's
   * next attempt is the next version, on the same right.
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

      if (!version.card.liveVersionId) {
        await this.entitlements.resumeAfterReview(tx, version.cardId, 'REJECTED', new Date());
      }
    }, { label: 'showcase.rejectVersion' });

    return this.getVersion(versionId);
  }
}
