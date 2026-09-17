import { prisma, uniquePhone, uniqueSuffix, type Location, type SeededQuestion } from './fixtures';

/**
 * A customer's request written straight into the tables, with every optional
 * field the form can carry — or none of them — and answers to the category's
 * questions. For the scenarios where the request's *content* is the subject
 * (what the owner sees read back) rather than the act of sending it.
 *
 * Left unverified (`phoneVerifiedAt: null`) unless told otherwise, so the
 * one-time-code card is on the page; the primary runtime's gate is off, so
 * nothing else about the request depends on it.
 */
export async function seedCustomerRequest(options: {
  customerId: string;
  categoryId: string;
  location: Location;
  /** The request's contact number; the customer's own when omitted. */
  customerPhone?: string;
  status?: 'SUBMITTED' | 'APPROVED';
  phoneVerifiedAt?: Date | null;
  /** `full` fills every optional column; `empty` leaves them all null. */
  content: 'full' | 'empty';
  neighborhood?: string;
  answers?: Array<{ question: SeededQuestion; value: string | string[] }>;
}) {
  const db = prisma();
  const suffix = uniqueSuffix();
  const now = new Date();
  const status = options.status ?? 'APPROVED';
  const full = options.content === 'full';

  const request = await db.serviceRequest.create({
    data: {
      categoryId: options.categoryId,
      customerId: options.customerId,
      requestNumber: `TR-E2E-${suffix}`,
      customerName: `E2E Müşteri ${suffix}`,
      customerPhone: options.customerPhone ?? uniquePhone(),
      customerEmail: `e2e-content-${suffix}@example.test`,
      city: options.location.city,
      district: options.location.district,
      neighborhood: full ? (options.neighborhood ?? null) : null,
      addressNote: full ? 'Kapıcıya haber verin, zil çalışmıyor.' : null,
      budgetMin: full ? 150_000 : null,
      budgetMax: full ? 250_000 : null,
      preferredDate: full ? new Date('2026-10-01T00:00:00.000Z') : null,
      preferredDateEnd: full ? new Date('2026-10-05T00:00:00.000Z') : null,
      urgency: full ? 'FLEXIBLE' : null,
      description: full ? 'Salon kliması soğutmuyor; dış ünite ses yapıyor.' : null,
      status,
      approvedAt: status === 'APPROVED' ? now : null,
      qualityScore: 80,
      phoneVerifiedAt: options.phoneVerifiedAt === undefined ? null : options.phoneVerifiedAt,
    },
    select: { id: true, requestNumber: true },
  });

  for (const answer of options.answers ?? []) {
    await db.serviceRequestAnswer.create({
      data: {
        requestId: request.id,
        questionId: answer.question.id,
        questionKey: answer.question.key,
        questionLabel: answer.question.label,
        questionType: Array.isArray(answer.value) ? 'MULTI_SELECT' : 'SELECT',
        value: answer.value,
      },
    });
  }

  return request;
}

/** Stamps the account's own proofs — the only columns any badge reads. */
export async function stampAccountProofs(
  userId: string,
  proofs: { emailVerifiedAt?: Date | null; phoneVerifiedAt?: Date | null },
): Promise<void> {
  await prisma().user.update({ where: { id: userId }, data: proofs });
}
