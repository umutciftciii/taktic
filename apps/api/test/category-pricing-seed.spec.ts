import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveTestDatabaseUrl } from './test-database';

/**
 * Verifies the migration + seed contract on a clean install: after seeding, the
 * seven starting categories carry the approved prices and no active category is
 * left unpriced.
 *
 * This runs the real seed script against the isolated test database, so it also
 * guards the CHECK constraint and the migration's "no unpriced active category"
 * assertion.
 */
const APPROVED_PRICES: Record<string, number> = {
  'klima-montaji': 4,
  'boya-badana': 4,
  'kombi-servisi': 3,
  'klima-servisi': 2,
  elektrikci: 2,
  'su-tesisatcisi': 2,
  'ev-temizligi': 1,
};

const repoRoot = resolve(__dirname, '../../..');
let prisma: PrismaClient;

beforeAll(async () => {
  const databaseUrl = resolveTestDatabaseUrl();

  execFileSync('pnpm', ['exec', 'prisma', 'db', 'seed'], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test' },
    stdio: 'ignore',
  });

  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
});

afterAll(async () => {
  await prisma?.$disconnect();
});

describe('seed + migration pricing smoke', () => {
  it('gives every starting category its approved offer credit cost', async () => {
    const categories = await prisma.serviceCategory.findMany({
      where: { slug: { in: Object.keys(APPROVED_PRICES) } },
      select: { slug: true, offerCreditCost: true, isActive: true },
    });

    expect(categories).toHaveLength(Object.keys(APPROVED_PRICES).length);

    for (const category of categories) {
      expect(category.offerCreditCost).toBe(APPROVED_PRICES[category.slug]);
      expect(category.isActive).toBe(true);
    }
  });

  it('leaves no active category without a price', async () => {
    const unpriced = await prisma.serviceCategory.findMany({
      where: { isActive: true, offerCreditCost: null },
      select: { slug: true },
    });

    expect(unpriced).toEqual([]);
  });

  it('stores only positive prices', async () => {
    const nonPositive = await prisma.serviceCategory.count({
      where: { offerCreditCost: { lte: 0 } },
    });

    expect(nonPositive).toBe(0);
  });
});
