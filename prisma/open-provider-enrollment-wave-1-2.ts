import { PrismaClient } from '@prisma/client';
import {
  openProviderEnrollment,
  waveEnrollmentSlugs,
} from './category-import/open-provider-enrollment';
import { WAVE_1 } from './category-import/wave-1';
import { WAVE_2 } from './category-import/wave-2';

/**
 * Opens the first two waves' draft services to provider applications.
 *
 *     pnpm db:open-provider-enrollment:wave-1-2
 *
 * One-off reconciliation for an environment that imported these waves before
 * the enrollment column existed: the definitions have always said these
 * services recruit, and the rows written back then could not say so. See
 * openProviderEnrollment for why the importer is not the place to fix that.
 *
 * Safe to run repeatedly — the second run reports zero and writes nothing — and
 * narrow by construction: it names two waves' draft services and touches no
 * other category, no released service, no group and no router. It never
 * releases anything, never prices anything and never contacts anybody.
 */
const prisma = new PrismaClient();

async function main() {
  const slugs = waveEnrollmentSlugs(WAVE_1, WAVE_2);
  const summary = await openProviderEnrollment(prisma, slugs);

  console.log(
    `[enrollment] wave 1+2: ${summary.targeted} taslak hizmet hedeflendi; ` +
      `${summary.opened} kategori başvuruya açıldı, ${summary.alreadyOpen} zaten açıktı, ` +
      `${summary.skipped} kategori taslak hizmet olmadığı için atlandı, ` +
      `${summary.missing} slug bu veritabanında yok.`,
  );

  if (summary.openedSlugs.length > 0) {
    console.log(`[enrollment] açılanlar: ${summary.openedSlugs.join(', ')}`);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
