import { Inject, Injectable } from '@nestjs/common';
import {
  Prisma,
  ProviderServiceAreaScope,
  ProviderStatus,
  ShowcaseCardKind,
} from '@prisma/client';
import { describeArea } from '../../common/provider-service-area-scope';
import { showcaseAreaKey } from '../../common/showcase-area-key';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveArea } from '../locations/turkey-locations';
import { ShowcaseFeedQueryDto } from './dto/showcase-feed.dto';
import { SHOWCASE_FEED_DEFAULT_LIMIT, SHOWCASE_FEED_MAX_LIMIT } from './showcase.constants';
import { showcaseAreaUnknown, showcaseLocationRequired } from './showcase.errors';

/**
 * The home page's vitrin shelf: which paid cards a visitor in one place sees,
 * and in what order.
 *
 * ## Matching is an index lookup, not a coverage scan
 *
 * A visitor who names a province, a district and a neighbourhood produces
 * **exactly three** candidate keys — "İstanbul geneli", "İstanbul/Kadıköy" and
 * "İstanbul/Kadıköy/Moda" — and the query asks `areaKey IN (…)` against a
 * partial index. Nothing is pulled into memory and filtered.
 *
 * This is the direct lesson of `listMatchingRequests`, which reads every area a
 * provider holds and filters them in JavaScript. That is acceptable for one
 * business's own panel; it is not acceptable for a page every visitor loads.
 *
 * A visitor who names only a province gets a prefix scan, which the
 * `text_pattern_ops` index answers.
 *
 * A visitor who names nothing gets **a refusal, not a national list**. Showing
 * somebody a business that cannot reach them is the exact opposite of what a
 * placement sells, and a provider paying for Kadıköy would be paying to appear
 * in Erzurum.
 *
 * ## Ordering: rounds, not runs
 *
 * The sort key is `(provider_rank, scope_rank DESC, startAt ASC, id ASC)`, and
 * `provider_rank` is the interesting half. It numbers each provider's own cards
 * — their best is 1, their second is 2 — so the feed reads:
 *
 *     round 1: every provider's best card
 *     round 2: every provider's second card
 *     round 3: …
 *
 * A provider with five cards gets five slots, in five different rounds rather
 * than five in a row. One business cannot fill the visitor's screen, and a
 * second card still has real — and honestly diminishing — value: its own title,
 * its own scope, its own slot, appearing once the round in front of it is done.
 *
 * This is what replaced refusing the sale. An earlier design stopped a provider
 * buying a second placement on a shelf they already occupied; that told a
 * paying business their second card was worth nothing, and cut the revenue
 * model at the point of sale to solve what is really a ranking problem.
 *
 * Inside a round:
 *
 * 1. `scope_rank DESC` — a business serving this exact neighbourhood is a
 *    closer promise than one serving the whole province. Not a purchasable
 *    advantage: it is the location itself.
 * 2. `startAt ASC` — order of purchase, and **fixed**. A randomised or rotating
 *    within-round order would mean a provider could not know what they bought.
 * 3. `id ASC` — a deterministic tie-break, so the same query twice gives the
 *    same page twice.
 *
 * **No field in this ordering can be bought.** Vitrin sells visibility, not
 * position. A boost tier would need its own column ahead of `provider_rank`,
 * and that would be a visible, deliberate decision rather than something this
 * key quietly leaves room for.
 *
 * ## Pagination
 *
 * Keyset, over the whole sort key. Not offset: the feed is live, placements
 * start and expire while somebody is reading, and an offset page two would
 * repeat and skip cards.
 */
@Injectable()
export class ShowcaseFeedService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(query: ShowcaseFeedQueryDto) {
    const city = query.city?.trim();
    if (!city) {
      throw showcaseLocationRequired();
    }

    // Resolved against the shipped location list, so "ISTANBUL", "istanbul" and
    // "İstanbul" are one place and a made-up district is a refusal rather than
    // an empty shelf that looks like "nobody advertises here".
    const area = resolveArea({
      city,
      district: query.district?.trim() || null,
      neighborhood: query.neighborhood?.trim() || null,
    });

    if (!area) {
      throw showcaseAreaUnknown();
    }

    const limit = Math.min(query.limit ?? SHOWCASE_FEED_DEFAULT_LIMIT, SHOWCASE_FEED_MAX_LIMIT);
    const cursor = decodeCursor(query.cursor);
    const now = new Date();

    const rows = await this.prisma.$queryRaw<FeedRow[]>(
      buildFeedQuery({
        keys: candidateAreaKeys(area),
        prefix: area.district === null ? `${showcaseAreaKey(area).split('|')[0]}|` : null,
        categoryId: query.categoryId?.trim() || null,
        kind: query.kind ?? null,
        now,
        cursor,
        // One extra row, so "is there another page" is answered by the query
        // rather than by a second count that could disagree with it.
        limit: limit + 1,
      }),
    );

    const page = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1]!) : null;

    return {
      location: {
        city: area.city,
        district: area.district,
        neighborhood: area.neighborhood,
        label: describeArea(area),
      },
      cards: page.map(toFeedCard),
      nextCursor,
    };
  }

  /**
   * One card's public page — reachable only while it is actually on the air.
   *
   * A card whose run has ended, been suspended or never existed all answer the
   * same 404. That is not tidiness: a card is a business's price list, and a
   * distinguishable "this exists but is not published" would let anyone walk
   * the id space and read what competitors are about to advertise and at what
   * price, before it is public.
   */
  async getPublicCard(cardId: string) {
    const now = new Date();

    const rows = await this.prisma.$queryRaw<FeedRow[]>(buildSingleCardQuery(cardId, now));
    const row = rows[0];

    if (!row) {
      return null;
    }

    return toFeedCard(row);
  }
}

/**
 * The keys a visitor's location can match — at most three, and exactly the
 * three levels a card area can name.
 *
 * The empty-string segments are what make this an equality lookup. See
 * `showcase-area-key.ts`: a key assembled from nullable parts would bind
 * nothing in a unique index and could not be compared with `IN` at all.
 */
function candidateAreaKeys(area: {
  city: string;
  district: string | null;
  neighborhood: string | null;
}): string[] {
  const keys = [showcaseAreaKey({ city: area.city, district: null, neighborhood: null })];

  if (area.district) {
    keys.push(showcaseAreaKey({ city: area.city, district: area.district, neighborhood: null }));

    if (area.neighborhood) {
      keys.push(showcaseAreaKey(area));
    }
  }

  return keys;
}

type FeedRow = {
  placementId: string;
  cardId: string;
  providerId: string;
  kindSnapshot: ShowcaseCardKind;
  startAt: Date;
  scopeRank: number;
  providerRank: bigint | number;
  areaScope: ProviderServiceAreaScope;
  areaCity: string;
  areaDistrict: string | null;
  areaNeighborhood: string | null;
  title: string;
  summary: string;
  scopeIncluded: string[];
  scopeExcluded: string[];
  imageUrl: string | null;
  responseSlaUrgentHours: number;
  responseSlaNormalHours: number;
  listedServicePriceAmount: number | null;
  listedServiceCurrency: string;
  categoryId: string;
  categoryName: string;
  categorySlug: string;
  providerBusinessName: string;
  providerCity: string;
  providerDistrict: string;
};

/**
 * What a visitor is given about a card.
 *
 * ## What is deliberately absent
 *
 * - `placementId` — the client has no use for it, and knowing it is the surface
 *   an IDOR walks. The lead endpoint resolves the placement from the card id on
 *   the server for exactly this reason.
 * - `purchaseId` and `priceAmountSnapshot` — what TakTick charged this business
 *   for the placement is nobody else's business, least of all the customer's.
 * - the placement's `endAt` — when a competitor's run expires is a competitor's
 *   information.
 * - `provider_rank` and `areaKey` — the ranking's own mechanics.
 * - the provider's telephone number and e-mail address — contact details open
 *   through `ContactRevealEvent` and through nothing else, and a public page is
 *   not an exception to that.
 *
 * ## The price key is absent, not null, on a promotion card
 *
 * A PROMOTION card makes no price claim, so the response carries no price key
 * at all rather than a null one. A client cannot render a price it was never
 * given, and it cannot mistake a null for "free". The database says the same
 * thing from the other side: `ShowcaseCardVersion_price_matches_kind`.
 *
 * The SLA hours are present on both kinds, because the card's call to action
 * renders its two urgency options from them — "Acil — 3 saat içinde dönüş",
 * "Normal — 24 saat içinde dönüş". The customer chooses by seeing the promise.
 */
function toFeedCard(row: FeedRow) {
  return {
    cardId: row.cardId,
    kind: row.kindSnapshot,
    title: row.title,
    summary: row.summary,
    scopeIncluded: row.scopeIncluded,
    scopeExcluded: row.scopeExcluded,
    imageUrl: row.imageUrl,
    responseSlaUrgentHours: row.responseSlaUrgentHours,
    responseSlaNormalHours: row.responseSlaNormalHours,
    category: { id: row.categoryId, name: row.categoryName, slug: row.categorySlug },
    areaLabel: describeArea({
      city: row.areaCity,
      district: row.areaDistrict,
      neighborhood: row.areaNeighborhood,
    }),
    areaScope: row.areaScope,
    provider: {
      id: row.providerId,
      businessName: row.providerBusinessName,
      city: row.providerCity,
      district: row.providerDistrict,
    },
    ...(row.kindSnapshot === ShowcaseCardKind.SERVICE
      ? {
          listedServicePriceAmount: row.listedServicePriceAmount,
          listedServiceCurrency: row.listedServiceCurrency,
        }
      : {}),
  };
}

export type ShowcaseFeedCard = ReturnType<typeof toFeedCard>;

type FeedCursor = {
  providerRank: number;
  scopeRank: number;
  startAt: string;
  id: string;
};

/**
 * The full candidate predicate, then the window function, then the keyset.
 *
 * The last three joins — card, pinned version, provider — are the reason this
 * is raw SQL rather than a Prisma query: `ROW_NUMBER() OVER (PARTITION BY …)`
 * has no Prisma expression, and computing `provider_rank` in JavaScript would
 * mean fetching every candidate on every page load.
 *
 * Every one of those joins is a live read rather than a denormalised column on
 * the placement. The card's status, the version's review state and the
 * provider's approval are facts owned by phase one and by the provider
 * lifecycle; a stale copy of any of them means an unapproved card on the home
 * page, and that is the one failure this feature must not have.
 */
function buildFeedQuery(input: {
  keys: string[];
  prefix: string | null;
  categoryId: string | null;
  kind: ShowcaseCardKind | null;
  now: Date;
  cursor: FeedCursor | null;
  limit: number;
}): Prisma.Sql {
  const areaMatch = input.prefix
    ? Prisma.sql`s."areaKey" LIKE ${`${input.prefix}%`}`
    : Prisma.sql`s."areaKey" IN (${Prisma.join(input.keys)})`;

  const categoryMatch = input.categoryId
    ? Prisma.sql`AND s."categoryId" = ${input.categoryId}`
    : Prisma.empty;

  const kindMatch = input.kind
    ? Prisma.sql`AND p."kindSnapshot" = ${Prisma.raw(`'${input.kind}'`)}::"ShowcaseCardKind"`
    : Prisma.empty;

  // The keyset, as one row comparison over the whole sort key. Written with
  // `scope_rank` negated because the key sorts it descending while everything
  // else ascends, and a row comparison has one direction.
  const keyset = input.cursor
    ? Prisma.sql`WHERE (ranked."providerRank", -ranked."scopeRank", ranked."startAt", ranked.id)
                     > (${input.cursor.providerRank}::bigint, ${-input.cursor.scopeRank}::int,
                        ${new Date(input.cursor.startAt)}::timestamp(3), ${input.cursor.id})`
    : Prisma.empty;

  return Prisma.sql`
    WITH candidates AS (
      SELECT
        p."id"                AS "placementId",
        p."cardId"            AS "cardId",
        p."providerId"        AS "providerId",
        p."kindSnapshot"      AS "kindSnapshot",
        p."startAt"           AS "startAt",
        s."scope"             AS "areaScope",
        s."city"              AS "areaCity",
        s."district"          AS "areaDistrict",
        s."neighborhood"      AS "areaNeighborhood",
        CASE s."scope"
          WHEN 'NEIGHBORHOOD' THEN 3
          WHEN 'DISTRICT'     THEN 2
          ELSE 1
        END                   AS "scopeRank",
        v."title"                     AS "title",
        v."summary"                   AS "summary",
        v."scopeIncluded"             AS "scopeIncluded",
        v."scopeExcluded"             AS "scopeExcluded",
        v."imageUrl"                  AS "imageUrl",
        v."responseSlaUrgentHours"    AS "responseSlaUrgentHours",
        v."responseSlaNormalHours"    AS "responseSlaNormalHours",
        v."listedServicePriceAmount"  AS "listedServicePriceAmount",
        v."listedServiceCurrency"     AS "listedServiceCurrency",
        cat."id"   AS "categoryId",
        cat."name" AS "categoryName",
        cat."slug" AS "categorySlug",
        pr."businessName" AS "providerBusinessName",
        pr."city"         AS "providerCity",
        pr."district"     AS "providerDistrict"
      FROM "ShowcasePlacementShelf" s
      JOIN "ShowcasePlacement"   p   ON p."id" = s."placementId"
      JOIN "ShowcaseCard"        c   ON c."id" = p."cardId"
      JOIN "ShowcaseCardVersion" v   ON v."id" = p."pinnedVersionId"
      JOIN "ProviderProfile"     pr  ON pr."id" = p."providerId"
      JOIN "ServiceCategory"     cat ON cat."id" = s."categoryId"
      WHERE s."active"
        AND ${areaMatch}
        ${categoryMatch}
        ${kindMatch}
        AND p."status" = 'ACTIVE'
        AND p."startAt" <= ${input.now}
        AND p."endAt"   >  ${input.now}
        AND c."status" = 'APPROVED'
        AND v."reviewStatus" = 'APPROVED'
        AND pr."status" = ${Prisma.raw(`'${ProviderStatus.APPROVED}'`)}::"ProviderStatus"
    ),
    -- One shelf row per card, so a card matching two of the visitor's three
    -- candidate keys is one result rather than two. The closest match wins,
    -- which is the same "a nearer promise ranks higher" rule the round order
    -- applies between providers.
    best_shelf AS (
      SELECT DISTINCT ON ("placementId") *
      FROM candidates
      ORDER BY "placementId", "scopeRank" DESC, "areaCity"
    ),
    ranked AS (
      SELECT
        best_shelf.*,
        ROW_NUMBER() OVER (
          PARTITION BY "providerId"
          ORDER BY "scopeRank" DESC, "startAt" ASC, "placementId" ASC
        ) AS "providerRank",
        "placementId" AS id
      FROM best_shelf
    )
    SELECT ranked.*
    FROM ranked
    ${keyset}
    ORDER BY ranked."providerRank" ASC, ranked."scopeRank" DESC, ranked."startAt" ASC, ranked.id ASC
    LIMIT ${input.limit}
  `;
}

/** The same projection for one card, with the same live-placement predicate. */
function buildSingleCardQuery(cardId: string, now: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT
      p."id"           AS "placementId",
      p."cardId"       AS "cardId",
      p."providerId"   AS "providerId",
      p."kindSnapshot" AS "kindSnapshot",
      p."startAt"      AS "startAt",
      s."scope"        AS "areaScope",
      s."city"         AS "areaCity",
      s."district"     AS "areaDistrict",
      s."neighborhood" AS "areaNeighborhood",
      CASE s."scope" WHEN 'NEIGHBORHOOD' THEN 3 WHEN 'DISTRICT' THEN 2 ELSE 1 END AS "scopeRank",
      1::bigint AS "providerRank",
      p."id" AS id,
      v."title"                     AS "title",
      v."summary"                   AS "summary",
      v."scopeIncluded"             AS "scopeIncluded",
      v."scopeExcluded"             AS "scopeExcluded",
      v."imageUrl"                  AS "imageUrl",
      v."responseSlaUrgentHours"    AS "responseSlaUrgentHours",
      v."responseSlaNormalHours"    AS "responseSlaNormalHours",
      v."listedServicePriceAmount"  AS "listedServicePriceAmount",
      v."listedServiceCurrency"     AS "listedServiceCurrency",
      cat."id"   AS "categoryId",
      cat."name" AS "categoryName",
      cat."slug" AS "categorySlug",
      pr."businessName" AS "providerBusinessName",
      pr."city"         AS "providerCity",
      pr."district"     AS "providerDistrict"
    FROM "ShowcasePlacement" p
    JOIN "ShowcasePlacementShelf" s ON s."placementId" = p."id" AND s."active"
    JOIN "ShowcaseCard"        c   ON c."id" = p."cardId"
    JOIN "ShowcaseCardVersion" v   ON v."id" = p."pinnedVersionId"
    JOIN "ProviderProfile"     pr  ON pr."id" = p."providerId"
    JOIN "ServiceCategory"     cat ON cat."id" = p."categoryId"
    WHERE p."cardId" = ${cardId}
      AND p."status" = 'ACTIVE'
      AND p."startAt" <= ${now}
      AND p."endAt"   >  ${now}
      AND c."status" = 'APPROVED'
      AND v."reviewStatus" = 'APPROVED'
      AND pr."status" = ${Prisma.raw(`'${ProviderStatus.APPROVED}'`)}::"ProviderStatus"
    ORDER BY "scopeRank" DESC, s."city" ASC
    LIMIT 1
  `;
}

/**
 * The cursor: the whole sort key, base64url'd.
 *
 * Opaque by intent rather than by encryption — it carries nothing that is not
 * already derivable from the page it came with, and a client that decoded it
 * could only ask for a page it could already ask for.
 */
function encodeCursor(row: FeedRow): string {
  const payload: FeedCursor = {
    providerRank: Number(row.providerRank),
    scopeRank: row.scopeRank,
    startAt: row.startAt.toISOString(),
    id: row.placementId,
  };

  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * A malformed cursor is treated as no cursor, deliberately.
 *
 * The alternative — a 400 — turns a stale bookmark or a truncated URL into an
 * error page for somebody who only wanted to browse. There is nothing to
 * protect here: a cursor grants no access, and the worst a bad one can do is
 * start the reader at the beginning.
 */
function decodeCursor(value: string | undefined): FeedCursor | null {
  if (!value) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    const cursor = parsed as Partial<FeedCursor>;
    if (
      typeof cursor.providerRank !== 'number' ||
      typeof cursor.scopeRank !== 'number' ||
      typeof cursor.startAt !== 'string' ||
      typeof cursor.id !== 'string' ||
      Number.isNaN(Date.parse(cursor.startAt))
    ) {
      return null;
    }

    return {
      providerRank: cursor.providerRank,
      scopeRank: cursor.scopeRank,
      startAt: cursor.startAt,
      id: cursor.id,
    };
  } catch {
    return null;
  }
}
