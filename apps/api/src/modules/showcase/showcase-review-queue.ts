import { Prisma, ShowcaseVersionReview } from '@prisma/client';

/**
 * The vitrin review queue — "Onay bekleyen kartlar" — as one predicate
 * (API-DASHBOARD-SHOWCASE-QUEUE-001).
 *
 * A row is a card *version* waiting on an operator. `GET /admin/showcase/versions`
 * lists exactly this set by default, and the dashboard's `pendingShowcaseReviews`
 * counts exactly this set; both read it from here, so the number on the
 * dashboard is the length of the list it links to.
 */
export function showcaseReviewQueueWhere(): Prisma.ShowcaseCardVersionWhereInput {
  return { reviewStatus: ShowcaseVersionReview.PENDING };
}
