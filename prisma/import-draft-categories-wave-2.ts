import { PrismaClient } from '@prisma/client';
import { importCategoryWave } from './category-import/import-categories';
import { WAVE_2 } from './category-import/wave-2';

/**
 * Applies the second draft category wave.
 *
 * A command of its own rather than another line inside
 * import-draft-categories.ts, for a reason an operator feels rather than reads:
 * the two waves went through separate reviews, they land in separate releases,
 * and "which wave am I applying" should be answered by the command itself
 * rather than by remembering what the shared one currently contains.
 *
 *     pnpm db:import:categories:wave-2
 *
 * Both waves share one importer, so the idempotency promise is the same one:
 * see importCategoryWave for exactly what a second run rewrites, and what it
 * deliberately leaves to an operator (status, pricing, hand-added questions).
 *
 * The wave lands DRAFT and unpriced. Nothing this script writes is visible to a
 * customer or to provider discovery, and nothing it writes can be released
 * without somebody setting a price first.
 */
const prisma = new PrismaClient();

/**
 * The two groups wave 2 hangs services under without creating them.
 *
 * They belong to wave 1, and re-declaring them here would make this script the
 * second owner of five rows it did not write. Checked up front so a database
 * that never had wave 1 applied fails with a sentence rather than with a
 * foreign-key error from three inserts in.
 */
const REQUIRED_GROUP_SLUGS = ['tadilat-ve-yenileme', 'yapi-ve-montaj'];

async function assertWave1GroupsExist() {
  const found = await prisma.serviceCategory.findMany({
    where: { slug: { in: REQUIRED_GROUP_SLUGS } },
    select: { slug: true },
  });

  const missing = REQUIRED_GROUP_SLUGS.filter(
    (slug) => !found.some((category) => category.slug === slug),
  );

  if (missing.length > 0) {
    throw new Error(
      `[category-import] wave-2 eksik üst gruplara bağlanıyor: ${missing.join(', ')}. ` +
        'Önce `pnpm db:import:categories` çalıştırın.',
    );
  }
}

async function main() {
  await assertWave1GroupsExist();

  const summary = await importCategoryWave(prisma, WAVE_2);
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
