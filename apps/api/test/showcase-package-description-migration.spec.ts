import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, resetDatabase, type TestContext } from './harness';

/**
 * The one data correction this migration set carries, run as SQL against
 * seeded rows.
 *
 * The suite's database has every migration applied before the first test, so
 * the migration cannot be observed by applying it. Instead its statement is
 * read from the file on disk — the exact bytes `prisma migrate deploy` will
 * run — and executed against a table seeded with every row it must and must
 * not touch. What is asserted is the whole point of narrowing it: one slug,
 * one exact old text, one new text, and nothing else in the database moves.
 */

const MIGRATION = resolve(
  __dirname,
  '../../../prisma/migrations/20260912090000_showcase_package_description_no_priority_promise/migration.sql',
);

const OLD_TEXT = '30 gün boyunca vitrinde yer al\r\nTaleplerde öncelik hizmeti';
const NEW_TEXT = '30 gün boyunca vitrin sayfalarında yayınlanın ve kartınızdan doğrudan talep alın.';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
});

function statement(): string {
  return readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

async function seedShowcase(slug: string, description: string | null) {
  return ctx.prisma.showcasePackage.create({
    data: {
      name: `Paket ${slug}`,
      slug,
      priceAmount: 1000,
      currency: 'TRY',
      durationDays: 30,
      description,
    },
  });
}

describe('the vitrin-mini-30 description correction', () => {
  it('is one UPDATE on ShowcasePackage.description, keyed on the slug and the exact old text', () => {
    const sql = statement();
    expect(sql.match(/\bUPDATE\b/gi)).toHaveLength(1);
    expect(sql).toMatch(/UPDATE "ShowcasePackage"/);
    expect(sql).toMatch(/SET "description" =/);
    expect(sql).toMatch(/"slug" = 'vitrin-mini-30'/);
    expect(sql).toMatch(/"description" = E'30 gün boyunca vitrinde yer al\\r\\nTaleplerde öncelik hizmeti'/);
    expect(sql).not.toMatch(/LIKE|ILIKE|DELETE|DROP|ALTER|INSERT|OfferCreditPackage/i);
  });

  it('rewrites exactly the untouched original row, and nothing else', async () => {
    const target = await seedShowcase('vitrin-mini-30', OLD_TEXT);
    // The same text on another vitrin package: not this correction's business.
    const other = await seedShowcase('vitrin-baska-30', OLD_TEXT);
    // The right slug, but an operator has edited the sentence since.
    const edited = await seedShowcase('vitrin-mini-30-x', `${OLD_TEXT} (güncellendi)`);
    // An offer/credit package carrying the words: a different table entirely.
    const offer = await ctx.prisma.offerCreditPackage.create({
      data: {
        name: 'Kredi paketi',
        slug: 'starter-20',
        type: 'ONE_TIME_CREDITS',
        creditAmount: 20,
        priceAmount: 1000,
        currency: 'TRY',
        description: OLD_TEXT,
      },
    });

    const changed = await ctx.prisma.$executeRawUnsafe(statement());
    expect(changed).toBe(1);

    expect(
      (await ctx.prisma.showcasePackage.findUniqueOrThrow({ where: { id: target.id } })).description,
    ).toBe(NEW_TEXT);
    expect(
      (await ctx.prisma.showcasePackage.findUniqueOrThrow({ where: { id: other.id } })).description,
    ).toBe(OLD_TEXT);
    expect(
      (await ctx.prisma.showcasePackage.findUniqueOrThrow({ where: { id: edited.id } })).description,
    ).toBe(`${OLD_TEXT} (güncellendi)`);
    expect(
      (await ctx.prisma.offerCreditPackage.findUniqueOrThrow({ where: { id: offer.id } })).description,
    ).toBe(OLD_TEXT);

    // Running it again is a no-op: the row no longer carries the old text.
    expect(await ctx.prisma.$executeRawUnsafe(statement())).toBe(0);
  });

  it('leaves the row alone when its text differs by a line ending or a character', async () => {
    await seedShowcase('vitrin-mini-30', OLD_TEXT.replace('\r\n', '\n'));
    expect(await ctx.prisma.$executeRawUnsafe(statement())).toBe(0);

    await resetDatabase(ctx.prisma);
    await seedShowcase('vitrin-mini-30', NEW_TEXT);
    expect(await ctx.prisma.$executeRawUnsafe(statement())).toBe(0);

    await resetDatabase(ctx.prisma);
    await seedShowcase('vitrin-mini-30', null);
    expect(await ctx.prisma.$executeRawUnsafe(statement())).toBe(0);
  });
});
