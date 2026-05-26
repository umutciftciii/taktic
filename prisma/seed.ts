import { PrismaClient, ServiceRequestQuestionType } from '@prisma/client';

const prisma = new PrismaClient();

const allowedSeedEnvironments = new Set(['development', 'test']);

const categories = [
  {
    slug: 'klima-servisi',
    name: 'Klima Servisi',
    description: 'Klima bakim, ariza ve servis talepleri.',
    sortOrder: 10,
    questions: [],
  },
  {
    slug: 'klima-montaji',
    name: 'Klima Montaji',
    description: 'Yeni veya mevcut klima montaji talepleri.',
    sortOrder: 20,
    questions: [
      {
        key: 'klima_tipi',
        label: 'Klima tipi nedir?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 10,
        options: [
          { key: 'split', label: 'Split klima' },
          { key: 'salon_tipi', label: 'Salon tipi klima' },
          { key: 'multi_split', label: 'Multi split klima' },
        ],
      },
      {
        key: 'montaj_yeri_hazir_mi',
        label: 'Montaj yeri hazir mi?',
        type: ServiceRequestQuestionType.BOOLEAN,
        isRequired: true,
        sortOrder: 20,
      },
      {
        key: 'kat_bilgisi',
        label: 'Montaj yapilacak kat bilgisi',
        type: ServiceRequestQuestionType.TEXT,
        isRequired: false,
        sortOrder: 30,
      },
    ],
  },
  {
    slug: 'kombi-servisi',
    name: 'Kombi Servisi',
    description: 'Kombi bakim, ariza ve servis talepleri.',
    sortOrder: 30,
    questions: [
      {
        key: 'servis_turu',
        label: 'Hangi kombi hizmetine ihtiyaciniz var?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 10,
        options: [
          { key: 'bakim', label: 'Bakim' },
          { key: 'ariza', label: 'Ariza' },
          { key: 'petek_temizligi', label: 'Petek temizligi' },
        ],
      },
      {
        key: 'marka',
        label: 'Kombi markasi',
        type: ServiceRequestQuestionType.TEXT,
        isRequired: false,
        sortOrder: 20,
      },
      {
        key: 'aciliyet',
        label: 'Ne kadar acil?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 30,
        options: [
          { key: 'bugun', label: 'Bugun' },
          { key: 'bu_hafta', label: 'Bu hafta' },
          { key: 'esnek', label: 'Esnek' },
        ],
      },
    ],
  },
  {
    slug: 'elektrikci',
    name: 'Elektrikci',
    description: 'Elektrik ariza, montaj ve onarim talepleri.',
    sortOrder: 40,
    questions: [
      {
        key: 'is_turu',
        label: 'Hangi elektrikci hizmetine ihtiyaciniz var?',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 10,
        options: [
          { key: 'ariza', label: 'Ariza' },
          { key: 'tesisat', label: 'Tesisat' },
          { key: 'avize_montaji', label: 'Avize montaji' },
          { key: 'priz_anahtar', label: 'Priz veya anahtar' },
        ],
      },
      {
        key: 'detay',
        label: 'Isin detaylarini kisaca anlatin',
        type: ServiceRequestQuestionType.TEXTAREA,
        isRequired: true,
        sortOrder: 20,
      },
      {
        key: 'gorsel_var_mi',
        label: 'Gorsel eklemek ister misiniz?',
        type: ServiceRequestQuestionType.IMAGE,
        isRequired: false,
        sortOrder: 30,
      },
    ],
  },
  {
    slug: 'su-tesisatcisi',
    name: 'Su Tesisatcisi',
    description: 'Su tesisati ariza ve onarim talepleri.',
    sortOrder: 50,
    questions: [],
  },
  {
    slug: 'boya-badana',
    name: 'Boya Badana',
    description: 'Ic mekan boya ve badana talepleri.',
    sortOrder: 60,
    questions: [],
  },
  {
    slug: 'ev-temizligi',
    name: 'Ev Temizligi',
    description: 'Ev temizligi talepleri.',
    sortOrder: 70,
    questions: [],
  },
];

const creditPackages = [
  {
    slug: 'starter-20',
    name: 'Başlangıç Paketi',
    creditAmount: 20,
    priceAmount: 49900,
    currency: 'TRY',
    sortOrder: 10,
  },
  {
    slug: 'pro-50',
    name: 'Pro Paket',
    creditAmount: 50,
    priceAmount: 99900,
    currency: 'TRY',
    sortOrder: 20,
  },
  {
    slug: 'business-100',
    name: 'Business Paket',
    creditAmount: 100,
    priceAmount: 179900,
    currency: 'TRY',
    sortOrder: 30,
  },
];

async function main() {
  if (!allowedSeedEnvironments.has(process.env.NODE_ENV)) {
    throw new Error(
      `Refusing to seed when NODE_ENV=${process.env.NODE_ENV ?? 'undefined'}. Set NODE_ENV=development or NODE_ENV=test.`,
    );
  }

  for (const category of categories) {
    const savedCategory = await prisma.serviceCategory.upsert({
      where: { slug: category.slug },
      update: {
        name: category.name,
        description: category.description,
        sortOrder: category.sortOrder,
        isActive: true,
      },
      create: {
        slug: category.slug,
        name: category.name,
        description: category.description,
        sortOrder: category.sortOrder,
        isActive: true,
      },
    });

    for (const question of category.questions) {
      await prisma.serviceRequestQuestion.upsert({
        where: {
          categoryId_key: {
            categoryId: savedCategory.id,
            key: question.key,
          },
        },
        update: {
          label: question.label,
          type: question.type,
          isRequired: question.isRequired,
          options: 'options' in question ? question.options : undefined,
          sortOrder: question.sortOrder,
          isActive: true,
        },
        create: {
          categoryId: savedCategory.id,
          key: question.key,
          label: question.label,
          type: question.type,
          isRequired: question.isRequired,
          options: 'options' in question ? question.options : undefined,
          sortOrder: question.sortOrder,
          isActive: true,
        },
      });
    }
  }

  for (const creditPackage of creditPackages) {
    await prisma.offerCreditPackage.upsert({
      where: { slug: creditPackage.slug },
      update: {
        creditAmount: creditPackage.creditAmount,
        priceAmount: creditPackage.priceAmount,
        currency: creditPackage.currency,
        sortOrder: creditPackage.sortOrder,
        isActive: true,
      },
      create: {
        ...creditPackage,
        isActive: true,
      },
    });
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
