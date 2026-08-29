import { PrismaClient } from '@prisma/client';
import { importCategoryWave } from './category-import/import-categories';
import { WAVE_1 } from './category-import/wave-1';

/**
 * Applies the draft category waves.
 *
 * Separate from `prisma/seed.ts` so it can be run on its own against an
 * environment that is already seeded — the founding seven categories, the
 * credit packages and the local admin are none of this script's business.
 *
 *     pnpm db:import:categories
 *
 * Safe to run repeatedly: see importCategoryWave for exactly what "idempotent"
 * covers, and what it deliberately leaves to an operator (status, pricing).
 *
 * The wave lands DRAFT. Nothing this script writes is visible to a customer or
 * to provider discovery until somebody releases it from the admin app.
 */
const prisma = new PrismaClient();

async function main() {
  const summary = await importCategoryWave(prisma, WAVE_1);
  console.log(
    `[category-import] ${summary.wave}: ` +
      `${summary.categoriesCreated} kategori oluşturuldu, ${summary.categoriesUpdated} güncellendi; ` +
      `${summary.questionsCreated} soru oluşturuldu, ${summary.questionsUpdated} güncellendi; ` +
      `${summary.conditionsWritten} koşul, ${summary.routerRulesWritten} yönlendirme kuralı yazıldı.`,
  );
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
