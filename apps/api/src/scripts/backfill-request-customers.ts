import { Prisma, PrismaClient, UserRole } from '@prisma/client';

type Mode = 'dry-run' | 'apply';

type RequestRow = {
  id: string;
  requestNumber: string | null;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
};

type ProcessOutcome =
  | { status: 'bound-existing'; userId: string; matchType: 'phone' | 'email' | 'both' }
  | { status: 'created-new'; userId: string }
  | { status: 'conflict'; phoneUserId: string; emailUserId: string }
  | { status: 'error'; message: string };

type Sample = { requestId: string; requestNumber: string | null; outcome: string };

type ConflictEntry = {
  requestId: string;
  requestNumber: string | null;
  normalizedPhone: string;
  normalizedEmail: string | null;
  phoneUserId: string;
  emailUserId: string;
};

type ErrorEntry = { requestId: string; requestNumber: string | null; message: string };

type Report = {
  mode: Mode;
  totalNullRequests: number;
  bindExistingCount: number;
  createNewRequestCount: number;
  uniqueNewCustomers: number;
  totalBoundCount: number;
  conflictCount: number;
  errorCount: number;
  samples: Sample[];
  conflicts: ConflictEntry[];
  errors: ErrorEntry[];
  customerCountBefore: number;
  customerCountAfter?: number;
  remainingNullAfter?: number;
  remainingNullProjected?: number;
};

function parseMode(argv: string[]): Mode {
  if (argv.includes('--apply')) return 'apply';
  if (argv.includes('--dry-run')) return 'dry-run';
  return 'dry-run';
}

function normalizePhone(value: string): string {
  return value.trim().replace(/[^\d+]/g, '');
}

function normalizeEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

async function loadNullRequests(prisma: PrismaClient): Promise<RequestRow[]> {
  return prisma.serviceRequest.findMany({
    where: { customerId: null },
    orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      requestNumber: true,
      customerName: true,
      customerPhone: true,
      customerEmail: true,
    },
  });
}

class CustomerResolver {
  private phoneCache = new Map<string, string | null>();
  private emailCache = new Map<string, string | null>();
  private simCounter = 0;

  constructor(private readonly prisma: PrismaClient) {}

  async lookupByPhone(phone: string): Promise<string | null> {
    const cached = this.phoneCache.get(phone);
    if (cached !== undefined) return cached;
    const user = await this.prisma.user.findFirst({
      where: { role: UserRole.CUSTOMER, phone },
      select: { id: true },
    });
    const id = user?.id ?? null;
    this.phoneCache.set(phone, id);
    return id;
  }

  async lookupByEmail(email: string): Promise<string | null> {
    const cached = this.emailCache.get(email);
    if (cached !== undefined) return cached;
    const user = await this.prisma.user.findFirst({
      where: { role: UserRole.CUSTOMER, email },
      select: { id: true },
    });
    const id = user?.id ?? null;
    this.emailCache.set(email, id);
    return id;
  }

  recordResolvedUser(phone: string, email: string | null, userId: string): void {
    this.phoneCache.set(phone, userId);
    if (email) this.emailCache.set(email, userId);
  }

  nextSimId(): string {
    this.simCounter += 1;
    return `SIM-NEW-${this.simCounter}`;
  }
}

async function bindRequest(
  prisma: PrismaClient,
  mode: Mode,
  requestId: string,
  userId: string,
): Promise<void> {
  if (mode !== 'apply') return;
  await prisma.$transaction(async (tx) => {
    await tx.serviceRequest.update({
      where: { id: requestId },
      data: { customerId: userId },
    });
  });
}

async function processRequest(
  prisma: PrismaClient,
  resolver: CustomerResolver,
  row: RequestRow,
  mode: Mode,
): Promise<ProcessOutcome> {
  const normPhone = normalizePhone(row.customerPhone);
  const normEmail = normalizeEmail(row.customerEmail);

  if (!normPhone) {
    return {
      status: 'error',
      message: 'normalized customer phone is empty; cannot resolve or create user',
    };
  }

  const byPhoneId = await resolver.lookupByPhone(normPhone);
  const byEmailId = normEmail ? await resolver.lookupByEmail(normEmail) : null;

  if (byPhoneId && byEmailId) {
    if (byPhoneId === byEmailId) {
      try {
        await bindRequest(prisma, mode, row.id, byPhoneId);
      } catch (err) {
        return { status: 'error', message: `bind failed: ${describeError(err)}` };
      }
      return { status: 'bound-existing', userId: byPhoneId, matchType: 'both' };
    }
    return { status: 'conflict', phoneUserId: byPhoneId, emailUserId: byEmailId };
  }

  if (byPhoneId) {
    try {
      await bindRequest(prisma, mode, row.id, byPhoneId);
    } catch (err) {
      return { status: 'error', message: `bind failed: ${describeError(err)}` };
    }
    return { status: 'bound-existing', userId: byPhoneId, matchType: 'phone' };
  }

  if (byEmailId) {
    try {
      await bindRequest(prisma, mode, row.id, byEmailId);
    } catch (err) {
      return { status: 'error', message: `bind failed: ${describeError(err)}` };
    }
    return { status: 'bound-existing', userId: byEmailId, matchType: 'email' };
  }

  if (mode === 'apply') {
    try {
      let createdUserId = '';
      await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            role: UserRole.CUSTOMER,
            name: row.customerName,
            phone: normPhone,
            email: normEmail,
            isActive: true,
            passwordHash: null,
          },
          select: { id: true },
        });
        createdUserId = user.id;
        await tx.serviceRequest.update({
          where: { id: row.id },
          data: { customerId: user.id },
        });
      });
      resolver.recordResolvedUser(normPhone, normEmail, createdUserId);
      return { status: 'created-new', userId: createdUserId };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return handleP2002OnCreate(prisma, resolver, row, normPhone, normEmail);
      }
      return { status: 'error', message: describeError(err) };
    }
  }

  // dry-run: simulate a new user so subsequent legacy requests with the same
  // phone/email reuse the same id instead of double-counting a create.
  const simId = resolver.nextSimId();
  resolver.recordResolvedUser(normPhone, normEmail, simId);
  return { status: 'created-new', userId: simId };
}

async function handleP2002OnCreate(
  prisma: PrismaClient,
  resolver: CustomerResolver,
  row: RequestRow,
  normPhone: string,
  normEmail: string | null,
): Promise<ProcessOutcome> {
  const [retryPhone, retryEmail] = await Promise.all([
    prisma.user.findFirst({
      where: { role: UserRole.CUSTOMER, phone: normPhone },
      select: { id: true },
    }),
    normEmail
      ? prisma.user.findFirst({
          where: { role: UserRole.CUSTOMER, email: normEmail },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);

  if (retryPhone && retryEmail && retryPhone.id !== retryEmail.id) {
    resolver.recordResolvedUser(normPhone, null, retryPhone.id);
    if (normEmail) resolver.recordResolvedUser('__unused__', normEmail, retryEmail.id);
    return { status: 'conflict', phoneUserId: retryPhone.id, emailUserId: retryEmail.id };
  }

  const userId = retryPhone?.id ?? retryEmail?.id ?? null;
  if (!userId) {
    return {
      status: 'error',
      message: 'P2002 on user create, but neither phone nor email matched on retry',
    };
  }

  resolver.recordResolvedUser(normPhone, normEmail, userId);
  try {
    await bindRequest(prisma, 'apply', row.id, userId);
  } catch (err) {
    return { status: 'error', message: `bind after P2002 failed: ${describeError(err)}` };
  }
  const matchType: 'phone' | 'email' | 'both' = retryPhone && retryEmail ? 'both' : retryPhone ? 'phone' : 'email';
  return { status: 'bound-existing', userId, matchType };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function pushSample(samples: Sample[], row: RequestRow, outcome: string): void {
  if (samples.length >= 10) return;
  samples.push({
    requestId: row.id,
    requestNumber: row.requestNumber,
    outcome,
  });
}

function printReport(r: Report): void {
  const header =
    r.mode === 'apply' ? 'BACKFILL REQUEST CUSTOMERS — APPLIED' : 'BACKFILL REQUEST CUSTOMERS — DRY-RUN';
  console.log(`\n=== ${header} ===\n`);
  console.log(`total null-customer requests : ${r.totalNullRequests}`);
  console.log(`bound to existing customer   : ${r.bindExistingCount}`);
  console.log(`bound via new customer       : ${r.createNewRequestCount}`);
  console.log(`distinct new customers       : ${r.uniqueNewCustomers}${r.mode === 'dry-run' ? ' (projected)' : ''}`);
  console.log(`total bound (existing+new)   : ${r.totalBoundCount}`);
  console.log(`conflicts                    : ${r.conflictCount}`);
  console.log(`errors                       : ${r.errorCount}`);
  if (r.mode === 'apply') {
    console.log(`remaining null after apply   : ${r.remainingNullAfter ?? 'n/a'}`);
  } else {
    console.log(`remaining null (projected)   : ${r.remainingNullProjected ?? 'n/a'}`);
  }
  console.log(`User(role=CUSTOMER) before   : ${r.customerCountBefore}`);
  if (r.customerCountAfter !== undefined) {
    console.log(`User(role=CUSTOMER) after    : ${r.customerCountAfter}`);
  }
  console.log('');

  if (r.samples.length > 0) {
    console.log(`Samples (up to 10):`);
    for (const s of r.samples) {
      console.log(`  - request=${s.requestId} number=${s.requestNumber ?? '(null)'} → ${s.outcome}`);
    }
    console.log('');
  }

  if (r.conflicts.length > 0) {
    console.log(`Conflicts (${r.conflicts.length}):`);
    for (const c of r.conflicts.slice(0, 20)) {
      console.log(
        `  - request=${c.requestId} number=${c.requestNumber ?? '(null)'} phone=${c.normalizedPhone} email=${c.normalizedEmail ?? '(null)'} phoneUser=${c.phoneUserId} emailUser=${c.emailUserId}`,
      );
    }
    if (r.conflicts.length > 20) {
      console.log(`  ... and ${r.conflicts.length - 20} more`);
    }
    console.log('');
  }

  if (r.errors.length > 0) {
    console.log(`Errors (${r.errors.length}):`);
    for (const e of r.errors.slice(0, 20)) {
      console.log(`  - request=${e.requestId} number=${e.requestNumber ?? '(null)'} message=${e.message}`);
    }
    if (r.errors.length > 20) {
      console.log(`  ... and ${r.errors.length - 20} more`);
    }
    console.log('');
  }

  if (r.mode === 'dry-run') {
    console.log('Dry-run only — no rows were modified. Re-run with --apply to persist changes.');
  }
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const customerCountBefore = await prisma.user.count({ where: { role: UserRole.CUSTOMER } });
    const rows = await loadNullRequests(prisma);
    const resolver = new CustomerResolver(prisma);

    const report: Report = {
      mode,
      totalNullRequests: rows.length,
      bindExistingCount: 0,
      createNewRequestCount: 0,
      uniqueNewCustomers: 0,
      totalBoundCount: 0,
      conflictCount: 0,
      errorCount: 0,
      samples: [],
      conflicts: [],
      errors: [],
      customerCountBefore,
    };

    const newUserIds = new Set<string>();

    for (const row of rows) {
      const outcome = await processRequest(prisma, resolver, row, mode);
      switch (outcome.status) {
        case 'bound-existing':
          report.bindExistingCount += 1;
          report.totalBoundCount += 1;
          pushSample(
            report.samples,
            row,
            `bind-existing(${outcome.matchType}) → user=${outcome.userId}`,
          );
          break;
        case 'created-new':
          report.createNewRequestCount += 1;
          report.totalBoundCount += 1;
          newUserIds.add(outcome.userId);
          pushSample(report.samples, row, `create-new → user=${outcome.userId}`);
          break;
        case 'conflict':
          report.conflictCount += 1;
          report.conflicts.push({
            requestId: row.id,
            requestNumber: row.requestNumber,
            normalizedPhone: normalizePhone(row.customerPhone),
            normalizedEmail: normalizeEmail(row.customerEmail),
            phoneUserId: outcome.phoneUserId,
            emailUserId: outcome.emailUserId,
          });
          break;
        case 'error':
          report.errorCount += 1;
          report.errors.push({
            requestId: row.id,
            requestNumber: row.requestNumber,
            message: outcome.message,
          });
          break;
      }
    }

    report.uniqueNewCustomers = newUserIds.size;

    if (mode === 'apply') {
      report.remainingNullAfter = await prisma.serviceRequest.count({
        where: { customerId: null },
      });
      report.customerCountAfter = await prisma.user.count({ where: { role: UserRole.CUSTOMER } });
    } else {
      report.remainingNullProjected = report.conflictCount + report.errorCount;
    }

    printReport(report);

    const hasFailures = report.conflictCount > 0 || report.errorCount > 0;
    if (mode === 'apply' && hasFailures) {
      process.exitCode = 2;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
