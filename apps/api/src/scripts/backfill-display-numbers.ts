import { NumberedEntityType, PrismaClient } from '@prisma/client';
import { getIstanbulYear } from '../modules/numbering/istanbul-year';
import { formatDisplayNumber, getDisplayNumberPrefix } from '../modules/numbering/numbering.service';

type Mode = 'dry-run' | 'apply';

type EntityKey = 'serviceRequest' | 'offer' | 'packagePurchase';

type EntityConfig = {
  key: EntityKey;
  entityType: NumberedEntityType;
  label: string;
};

type Row = {
  id: string;
  createdAt: Date;
  number: string | null;
};

type YearBucket = {
  year: number;
  used: Set<number>;
  maxUsed: number;
  toAssign: Row[];
};

type EntityReport = {
  label: string;
  entityType: NumberedEntityType;
  totalRows: number;
  alreadyNumbered: number;
  malformed: { id: string; value: string }[];
  duplicates: { value: string; ids: string[] }[];
  assigned: number;
  perYear: {
    year: number;
    prefix: string;
    previousMaxUsed: number;
    finalLastNumber: number;
    assignedInYear: number;
  }[];
  remainingNull: number;
};

const ENTITY_CONFIGS: EntityConfig[] = [
  { key: 'serviceRequest', entityType: NumberedEntityType.SERVICE_REQUEST, label: 'ServiceRequest' },
  { key: 'offer', entityType: NumberedEntityType.OFFER, label: 'Offer' },
  { key: 'packagePurchase', entityType: NumberedEntityType.PACKAGE_PURCHASE, label: 'PackagePurchase' },
];

const NUMBER_COLUMN: Record<EntityKey, string> = {
  serviceRequest: 'requestNumber',
  offer: 'offerNumber',
  packagePurchase: 'purchaseNumber',
};

function parseMode(argv: string[]): Mode {
  if (argv.includes('--apply')) return 'apply';
  if (argv.includes('--dry-run')) return 'dry-run';
  return 'dry-run';
}

function parseSequenceFromNumber(value: string, expectedPrefix: string, expectedYear: number): number | null {
  const match = /^([A-Z]+)-(\d{4})-(\d{6})$/.exec(value);
  if (!match) return null;
  const [, prefix, yearStr, seqStr] = match as unknown as [string, string, string, string];
  if (prefix !== expectedPrefix) return null;
  const year = Number.parseInt(yearStr, 10);
  if (year !== expectedYear) return null;
  const seq = Number.parseInt(seqStr, 10);
  if (!Number.isFinite(seq) || seq <= 0) return null;
  return seq;
}

async function loadRows(prisma: PrismaClient, key: EntityKey): Promise<Row[]> {
  if (key === 'serviceRequest') {
    const rows = await prisma.serviceRequest.findMany({
      select: { id: true, createdAt: true, requestNumber: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => ({ id: r.id, createdAt: r.createdAt, number: r.requestNumber }));
  }
  if (key === 'offer') {
    const rows = await prisma.offer.findMany({
      select: { id: true, createdAt: true, offerNumber: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => ({ id: r.id, createdAt: r.createdAt, number: r.offerNumber }));
  }
  const rows = await prisma.packagePurchase.findMany({
    select: { id: true, createdAt: true, purchaseNumber: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((r) => ({ id: r.id, createdAt: r.createdAt, number: r.purchaseNumber }));
}

async function applyNumber(
  prisma: PrismaClient,
  key: EntityKey,
  id: string,
  value: string,
): Promise<void> {
  if (key === 'serviceRequest') {
    await prisma.serviceRequest.update({ where: { id }, data: { requestNumber: value } });
    return;
  }
  if (key === 'offer') {
    await prisma.offer.update({ where: { id }, data: { offerNumber: value } });
    return;
  }
  await prisma.packagePurchase.update({ where: { id }, data: { purchaseNumber: value } });
}

async function processEntity(
  prisma: PrismaClient,
  config: EntityConfig,
  mode: Mode,
): Promise<EntityReport> {
  const rows = await loadRows(prisma, config.key);
  const prefix = getDisplayNumberPrefix(config.entityType);

  const buckets = new Map<number, YearBucket>();
  const malformed: { id: string; value: string }[] = [];
  const seenByValue = new Map<string, string[]>();
  let alreadyNumbered = 0;

  for (const row of rows) {
    const year = getIstanbulYear(row.createdAt);
    let bucket = buckets.get(year);
    if (!bucket) {
      bucket = { year, used: new Set(), maxUsed: 0, toAssign: [] };
      buckets.set(year, bucket);
    }

    if (row.number === null) {
      bucket.toAssign.push(row);
      continue;
    }

    alreadyNumbered += 1;
    const seq = parseSequenceFromNumber(row.number, prefix, year);
    if (seq === null) {
      malformed.push({ id: row.id, value: row.number });
      continue;
    }
    bucket.used.add(seq);
    if (seq > bucket.maxUsed) bucket.maxUsed = seq;

    const existing = seenByValue.get(row.number);
    if (existing) {
      existing.push(row.id);
    } else {
      seenByValue.set(row.number, [row.id]);
    }
  }

  const duplicates: { value: string; ids: string[] }[] = [];
  for (const [value, ids] of seenByValue.entries()) {
    if (ids.length > 1) duplicates.push({ value, ids });
  }

  let assigned = 0;
  const perYear: EntityReport['perYear'] = [];

  for (const bucket of [...buckets.values()].sort((a, b) => a.year - b.year)) {
    const previousMaxUsed = bucket.maxUsed;
    let cursor = previousMaxUsed;
    let assignedInYear = 0;

    for (const row of bucket.toAssign) {
      do {
        cursor += 1;
      } while (bucket.used.has(cursor));
      bucket.used.add(cursor);
      const value = formatDisplayNumber(config.entityType, bucket.year, cursor);
      if (mode === 'apply') {
        await applyNumber(prisma, config.key, row.id, value);
      }
      assignedInYear += 1;
      assigned += 1;
    }

    const finalLastNumber = cursor;

    if (mode === 'apply' && finalLastNumber > 0) {
      await prisma.sequenceCounter.upsert({
        where: { entityType_year: { entityType: config.entityType, year: bucket.year } },
        create: {
          entityType: config.entityType,
          year: bucket.year,
          lastNumber: finalLastNumber,
        },
        update: { lastNumber: finalLastNumber },
      });
    }

    perYear.push({
      year: bucket.year,
      prefix,
      previousMaxUsed,
      finalLastNumber,
      assignedInYear,
    });
  }

  let remainingNull = 0;
  if (mode === 'dry-run') {
    remainingNull = 0;
  } else {
    if (config.key === 'serviceRequest') {
      remainingNull = await prisma.serviceRequest.count({ where: { requestNumber: null } });
    } else if (config.key === 'offer') {
      remainingNull = await prisma.offer.count({ where: { offerNumber: null } });
    } else {
      remainingNull = await prisma.packagePurchase.count({ where: { purchaseNumber: null } });
    }
  }

  return {
    label: config.label,
    entityType: config.entityType,
    totalRows: rows.length,
    alreadyNumbered,
    malformed,
    duplicates,
    assigned,
    perYear,
    remainingNull,
  };
}

function printReport(reports: EntityReport[], mode: Mode): void {
  const header = mode === 'apply' ? 'BACKFILL APPLIED' : 'BACKFILL DRY-RUN';
  console.log(`\n=== ${header} ===\n`);
  for (const report of reports) {
    console.log(`[${report.label}]`);
    console.log(`  column         : ${NUMBER_COLUMN[entityKeyFor(report.entityType)]}`);
    console.log(`  total rows     : ${report.totalRows}`);
    console.log(`  already numbered: ${report.alreadyNumbered}`);
    console.log(`  assigned       : ${report.assigned}`);
    console.log(`  remaining null : ${report.remainingNull} (post-apply only; 0 in dry-run)`);
    console.log(`  malformed      : ${report.malformed.length}`);
    if (report.malformed.length > 0) {
      for (const m of report.malformed.slice(0, 10)) {
        console.log(`     - id=${m.id} value=${m.value}`);
      }
      if (report.malformed.length > 10) {
        console.log(`     ... and ${report.malformed.length - 10} more`);
      }
    }
    console.log(`  duplicates     : ${report.duplicates.length}`);
    if (report.duplicates.length > 0) {
      for (const d of report.duplicates.slice(0, 10)) {
        console.log(`     - value=${d.value} ids=${d.ids.join(',')}`);
      }
    }
    if (report.perYear.length === 0) {
      console.log(`  per-year       : (none)`);
    } else {
      console.log(`  per-year       :`);
      for (const y of report.perYear) {
        console.log(
          `     - ${y.prefix}-${y.year}: previousMaxUsed=${y.previousMaxUsed} assigned=${y.assignedInYear} finalLastNumber=${y.finalLastNumber}`,
        );
      }
    }
    console.log('');
  }

  const hasIssues = reports.some((r) => r.malformed.length > 0 || r.duplicates.length > 0);
  if (hasIssues) {
    console.log('NOTE: malformed or duplicate values detected. Backfill did NOT overwrite them.');
  }
  if (mode === 'dry-run') {
    console.log('Dry-run only — no rows were modified. Re-run with --apply to persist changes.');
  }
}

function entityKeyFor(entityType: NumberedEntityType): EntityKey {
  switch (entityType) {
    case NumberedEntityType.SERVICE_REQUEST:
      return 'serviceRequest';
    case NumberedEntityType.OFFER:
      return 'offer';
    case NumberedEntityType.PACKAGE_PURCHASE:
      return 'packagePurchase';
  }
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const reports: EntityReport[] = [];
    for (const config of ENTITY_CONFIGS) {
      const report = await processEntity(prisma, config, mode);
      reports.push(report);
    }
    printReport(reports, mode);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
