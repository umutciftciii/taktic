import { prisma } from './fixtures';

/**
 * Vitrin rows written straight to the database, for specs whose subject
 * starts after a card is on the air.
 *
 * The same shapes the vitrin specs restate inline, gathered once for the specs
 * that only need a live card to exist. Every value is restated here rather
 * than imported from the API — this suite talks to the application over HTTP
 * and to the database through Prisma, and must not share a constant with the
 * code it is testing. The fold in {@link showcaseAreaKey} is three lines and a
 * database CHECK guards its shape.
 */

export function showcaseAreaKey(city: string, district: string): string {
  const fold = (value: string) =>
    value.normalize('NFC').trim().toLocaleLowerCase('tr-TR').replace(/ı/g, 'i');
  return `${fold(city)}|${fold(district)}|`;
}

export async function seedApprovedShowcaseCard(options: {
  providerId: string;
  categoryId: string;
  city: string;
  district: string;
  title: string;
}) {
  const db = prisma();
  const now = new Date();

  const card = await db.showcaseCard.create({
    data: {
      providerId: options.providerId,
      kind: 'SERVICE',
      categoryId: options.categoryId,
      status: 'APPROVED',
    },
  });

  const version = await db.showcaseCardVersion.create({
    data: {
      cardId: card.id,
      versionNumber: 1,
      kindSnapshot: 'SERVICE',
      title: options.title,
      summary: 'Standart kapsamda klima bakımı ve filtre temizliği.',
      scopeIncluded: ['Filtre temizliği', 'Gaz basıncı kontrolü'],
      scopeExcluded: ['Gaz dolumu'],
      listedServicePriceAmount: 150_000,
      listedServiceCurrency: 'TRY',
      responseSlaUrgentHours: 3,
      responseSlaNormalHours: 24,
      priceTermsVersion: 'v1',
      priceTermsAcceptedAt: now,
      reviewStatus: 'APPROVED',
      submittedAt: now,
      publishedAt: now,
      areas: {
        create: [
          {
            scope: 'DISTRICT',
            city: options.city,
            district: options.district,
            neighborhood: null,
            areaKey: showcaseAreaKey(options.city, options.district),
          },
        ],
      },
    },
  });

  await db.showcaseCard.update({ where: { id: card.id }, data: { liveVersionId: version.id } });

  return { card, version };
}

/** A settled vitrin purchase and the live run it produced. */
export async function seedLiveShowcasePlacement(options: {
  providerId: string;
  cardId: string;
  versionId: string;
  categoryId: string;
  city: string;
  district: string;
}) {
  const db = prisma();
  const now = new Date();
  const endAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const pkg = await db.showcasePackage.create({
    data: {
      name: 'E2E Vitrin 30 Gün',
      slug: `vitrin-e2e-${Date.now()}-${Math.floor(Math.random() * 10_000)}`,
      priceAmount: 49_900,
      currency: 'TRY',
      durationDays: 30,
    },
  });

  const owner = await db.providerProfile.findUniqueOrThrow({
    where: { id: options.providerId },
    select: { userId: true },
  });

  const acceptance = await db.showcaseCardPriceTermsAcceptance.create({
    data: {
      providerId: options.providerId,
      cardId: options.cardId,
      acceptedByUserId: owner.userId!,
      termsVersion: 'v1',
      termsTextSnapshot:
        'Kartta belirtilen hizmet bedeli ve kapsam hizmet verenin sorumluluğundadır. ' +
        'TakTick bu hizmet bedelini tahsil etmez ve taraflar arasındaki ödemeye müdahil olmaz.',
    },
  });

  const purchase = await db.packagePurchase.create({
    data: {
      providerId: options.providerId,
      kind: 'SHOWCASE_PACKAGE',
      showcasePackageId: pkg.id,
      showcaseCardId: options.cardId,
      showcaseCardVersionId: options.versionId,
      durationDaysSnapshot: 30,
      creditAmountSnapshot: 0,
      priceAmountSnapshot: pkg.priceAmount,
      currencySnapshot: 'TRY',
      packageNameSnapshot: pkg.name,
      showcasePriceTermsAcceptanceId: acceptance.id,
      status: 'PAID',
      paidAt: now,
      paymentProvider: 'mock',
    },
  });

  const placement = await db.showcasePlacement.create({
    data: {
      purchaseId: purchase.id,
      providerId: options.providerId,
      showcasePackageId: pkg.id,
      cardId: options.cardId,
      pinnedVersionId: options.versionId,
      categoryId: options.categoryId,
      kindSnapshot: 'SERVICE',
      packageNameSnapshot: pkg.name,
      priceAmountSnapshot: pkg.priceAmount,
      currencySnapshot: 'TRY',
      durationDaysSnapshot: 30,
      priceTermsVersionSnapshot: acceptance.termsVersion,
      priceTermsTextSnapshot: acceptance.termsTextSnapshot,
      startAt: now,
      endAt,
      status: 'ACTIVE',
      shelves: {
        create: [
          {
            providerId: options.providerId,
            categoryId: options.categoryId,
            areaKey: showcaseAreaKey(options.city, options.district),
            scope: 'DISTRICT',
            city: options.city,
            district: options.district,
            neighborhood: null,
            active: true,
            endAt,
          },
        ],
      },
    },
  });

  return { pkg, purchase, placement };
}

/**
 * Takes every run off the air for the duration of a callback, and puts them
 * back exactly as they were.
 *
 * The suite runs serially against one database, and every vitrin spec before
 * this one may have left a live card behind. "No active placement anywhere" is
 * therefore a state a test has to produce, not one it can assume — and it has
 * to undo it, because the specs after it assume the opposite. Rows are moved
 * by their end, which every reader checks for itself: a run whose end is in
 * the past is not on the air whatever its status says, and the status column
 * is left untouched so a restore is one update per row.
 */
export async function withNoActiveShowcasePlacements<T>(run: () => Promise<T>): Promise<T> {
  const db = prisma();
  const live = await db.showcasePlacement.findMany({
    where: { status: { in: ['ACTIVE', 'PENDING_ACTIVATION', 'SUSPENDED'] }, endAt: { gt: new Date() } },
    select: { id: true, startAt: true, endAt: true },
  });

  for (const placement of live) {
    // `endAt > startAt` is a CHECK; one second after the start is in the past
    // for every run this suite seeds.
    await db.showcasePlacement.update({
      where: { id: placement.id },
      data: { endAt: new Date(placement.startAt.getTime() + 1000) },
    });
  }

  try {
    return await run();
  } finally {
    for (const placement of live) {
      await db.showcasePlacement.update({
        where: { id: placement.id },
        data: { endAt: placement.endAt },
      });
    }
  }
}

/**
 * Takes live runs off the air after a test.
 *
 * The home shelf lists the newest live cards up to a fixed limit, so a spec
 * that leaves its placements live pushes another spec's card off the shelf
 * and fails it later in the run. `EXPIRED`, with `endAt` a second after
 * `startAt` so the CHECK on the window holds — the same retirement
 * request-identity-gate.spec.ts performs.
 */
export async function retireShowcasePlacements(ids: readonly string[]): Promise<void> {
  const db = prisma();
  for (const id of ids) {
    const run = await db.showcasePlacement.findUnique({ where: { id }, select: { startAt: true } });
    if (!run) continue;
    await db.showcasePlacement.update({
      where: { id },
      data: { status: 'EXPIRED', endAt: new Date(run.startAt.getTime() + 1000) },
    });
  }
}
