import { PrismaClient, ServiceRequestQuestionType, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const allowedSeedEnvironments = new Set(['development', 'test']);

const categories = [
  {
    slug: 'klima-servisi',
    offerCreditCost: 2,
    name: 'Klima Servisi',
    description: 'Klima bakim, ariza ve servis talepleri.',
    sortOrder: 10,
    questions: [],
  },
  {
    slug: 'klima-montaji',
    offerCreditCost: 4,
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
    offerCreditCost: 3,
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
    offerCreditCost: 2,
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
    offerCreditCost: 2,
    name: 'Su Tesisatcisi',
    description: 'Su tesisati ariza ve onarim talepleri.',
    sortOrder: 50,
    questions: [],
  },
  {
    slug: 'boya-badana',
    offerCreditCost: 4,
    name: 'Boya Badana',
    description: 'Ic mekan boya ve badana talepleri.',
    sortOrder: 60,
    questions: [],
  },
  {
    slug: 'ev-temizligi',
    offerCreditCost: 1,
    name: 'Ev Temizligi',
    description: 'Ev temizligi talepleri.',
    sortOrder: 70,
    questions: [],
  },
];

// Monetary values throughout the platform are stored as integers in the
// currency's minor unit (kuruş for TRY, cents for USD/EUR). When seeding,
// always express prices in minor units. For TRY this means multiplying the
// nominal Turkish-lira value by 100 — `priceAmount: 49900` represents 499,00 TL,
// `priceAmount: 14990` represents 149,90 TL, and so on. Helper `tlToMinor`
// keeps the conversion explicit and self-documenting.
function tlToMinor(amount: number): number {
  return Math.round(amount * 100);
}

const creditPackages = [
  {
    slug: 'starter-20',
    name: 'Başlangıç Paketi',
    creditAmount: 20,
    // 499,00 TL = 49900 kuruş
    priceAmount: tlToMinor(499),
    currency: 'TRY',
    sortOrder: 10,
  },
  {
    slug: 'pro-50',
    name: 'Pro Paket',
    creditAmount: 50,
    // 999,00 TL = 99900 kuruş
    priceAmount: tlToMinor(999),
    currency: 'TRY',
    sortOrder: 20,
  },
  {
    slug: 'business-100',
    name: 'Business Paket',
    creditAmount: 100,
    // 1.799,00 TL = 179900 kuruş
    priceAmount: tlToMinor(1799),
    currency: 'TRY',
    sortOrder: 30,
  },
];

const localAdmin = {
  email: 'admin@taktic.local',
  password: 'ChangeMe123!',
  name: 'Local Admin',
};

async function main() {
  if (!allowedSeedEnvironments.has(process.env.NODE_ENV)) {
    throw new Error(
      `Refusing to seed when NODE_ENV=${process.env.NODE_ENV ?? 'undefined'}. Set NODE_ENV=development or NODE_ENV=test.`,
    );
  }

  for (const category of categories) {
    const existingCategory = await prisma.serviceCategory.findUnique({
      where: { slug: category.slug },
      select: { offerCreditCost: true },
    });

    const savedCategory = await prisma.serviceCategory.upsert({
      where: { slug: category.slug },
      update: {
        name: category.name,
        description: category.description,
        sortOrder: category.sortOrder,
        isActive: true,
        // Only fill the price when it has never been set, so re-seeding a local
        // database does not silently revert a price an admin changed.
        ...(existingCategory?.offerCreditCost == null
          ? { offerCreditCost: category.offerCreditCost }
          : {}),
      },
      create: {
        slug: category.slug,
        name: category.name,
        description: category.description,
        sortOrder: category.sortOrder,
        isActive: true,
        offerCreditCost: category.offerCreditCost,
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

  const existingAdmin = await prisma.user.findUnique({
    where: { email: localAdmin.email },
    select: { id: true },
  });

  if (!existingAdmin) {
    await prisma.user.create({
      data: {
        email: localAdmin.email,
        name: localAdmin.name,
        role: UserRole.SUPER_ADMIN,
        isActive: true,
        passwordHash: await bcrypt.hash(localAdmin.password, 12),
      },
    });
  } else {
    await prisma.user.update({
      where: { email: localAdmin.email },
      data: {
        role: UserRole.SUPER_ADMIN,
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
