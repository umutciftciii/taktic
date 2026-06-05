import { Injectable } from '@nestjs/common';
import { NumberedEntityType, Prisma } from '@prisma/client';
import { getIstanbulYear } from './istanbul-year';

const PREFIX_BY_ENTITY: Record<NumberedEntityType, string> = {
  SERVICE_REQUEST: 'REQ',
  OFFER: 'OFF',
  PACKAGE_PURCHASE: 'PKG',
};

const SEQUENCE_PADDING = 6;

export type NumberingTransactionClient = Prisma.TransactionClient;

export function getDisplayNumberPrefix(entityType: NumberedEntityType): string {
  return PREFIX_BY_ENTITY[entityType];
}

export function formatDisplayNumber(
  entityType: NumberedEntityType,
  year: number,
  sequence: number,
): string {
  const prefix = PREFIX_BY_ENTITY[entityType];
  return `${prefix}-${year}-${String(sequence).padStart(SEQUENCE_PADDING, '0')}`;
}

@Injectable()
export class NumberingService {
  async generateDisplayNumber(
    tx: NumberingTransactionClient,
    entityType: NumberedEntityType,
    date: Date = new Date(),
  ): Promise<string> {
    const year = getIstanbulYear(date);
    const counter = await tx.sequenceCounter.upsert({
      where: { entityType_year: { entityType, year } },
      create: { entityType, year, lastNumber: 1 },
      update: { lastNumber: { increment: 1 } },
      select: { lastNumber: true },
    });
    return formatDisplayNumber(entityType, year, counter.lastNumber);
  }
}
