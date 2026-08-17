import { PrismaClient } from '@prisma/client';
import { requireE2eDatabaseUrl } from './database-url';

/**
 * Every table the suite may create rows in, ordered so a plain TRUNCATE list
 * satisfies the foreign keys (CASCADE covers the rest).
 *
 * Kept as its own list rather than imported from the Vitest harness: that
 * harness boots NestJS to be useful, and this file must stay a thin database
 * client the Playwright config can import without pulling an application
 * framework into the test runner.
 */
const TRUNCATED_TABLES = [
  'NotificationLog',
  'PhoneVerification',
  'ProviderCreditTransaction',
  'PackagePurchase',
  'Offer',
  'ServiceRequestAnswer',
  'ServiceRequest',
  'ServiceRequestQuestion',
  'ProviderServiceArea',
  'ProviderServiceCategory',
  'ProviderProfile',
  'OfferCreditPackage',
  'ServiceCategory',
  'CustomerNote',
  'CustomerActivationToken',
  'AdminInviteToken',
  'Session',
  'SequenceCounter',
  'User',
];

let client: PrismaClient | null = null;

/**
 * A client bound to the `_e2e` database, whatever DATABASE_URL happens to say.
 * The URL is validated on the way in, so importing this module can never
 * connect to the development database by accident.
 */
export function e2ePrisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      datasources: { db: { url: requireE2eDatabaseUrl() } },
    });
  }

  return client;
}

export async function disconnectE2ePrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}

export async function truncateE2eDatabase(prisma: PrismaClient): Promise<void> {
  const list = TRUNCATED_TABLES.map((table) => `"public"."${table}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`);
}
