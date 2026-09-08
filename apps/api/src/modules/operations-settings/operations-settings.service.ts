import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS,
  MAX_UNVIEWED_OFFER_REFUND_WINDOW_HOURS,
  MIN_UNVIEWED_OFFER_REFUND_WINDOW_HOURS,
  unviewedOfferRefundNotice,
} from '../offers/refund-policy';
import { SaveOperationsSettingsDto } from './dto/save-operations-settings.dto';

/**
 * The operations settings a super admin maintains, read and written.
 *
 * One row, on a constant id, upserted — so "create" and "update" are the same
 * operation and two operators saving at once produce one row rather than a
 * race. The database refuses any other id.
 *
 * The absence of a row is a real answer, not a gap: it means the product
 * default, which is what every offer already in the database was sold under. So
 * this service never needs a seed, and a fresh deployment behaves exactly like
 * one whose operator has saved 48.
 *
 * What this service deliberately does *not* do is decide anything about an
 * offer that already exists. It answers "what is the next offer sold under?";
 * the offer itself carries the answer it was given, and the refund worker reads
 * that snapshot.
 */

export const OPERATIONS_SETTINGS_ID = 'singleton';

/** The audit row's `setting` column, and the field name it names. */
export const UNVIEWED_OFFER_REFUND_WINDOW_SETTING = 'unviewedOfferRefundWindowHours';

const settingsSelect = {
  unviewedOfferRefundWindowHours: true,
} satisfies Prisma.OperationsSettingsSelect;

export type OperationsSettingsView = {
  /**
   * False until an operator has saved the window once; the values below are the
   * defaults.
   *
   * Derived from the audit trail rather than from the existence of the settings
   * row, because the row is now shared: switching a background job on creates
   * it, and a screen that read "Kayıtlı" off that would tell an operator they
   * had chosen 48 hours when nobody had. A change row for this setting is
   * written by — and only by — a real save of it, including the first.
   */
  configured: boolean;
  unviewedOfferRefundWindowHours: number;
  /** The bounds the form and the database both enforce. */
  minUnviewedOfferRefundWindowHours: number;
  maxUnviewedOfferRefundWindowHours: number;
  defaultUnviewedOfferRefundWindowHours: number;
  /** The exact sentence a provider is shown for an offer created right now. */
  unviewedOfferRefundNotice: string;
  /**
   * When this setting was last saved, and by whom.
   *
   * Taken from the newest change row rather than from the settings row's own
   * `updatedAt`/`updatedBy`, for the reason `configured` is: the row is shared
   * with the scheduler switches, and its columns answer "who last touched this
   * row" — which is not the same question as "who last set the refund window".
   */
  updatedAt: Date | null;
  updatedBy: { id: string; name: string | null } | null;
  /** The most recent changes to this setting, newest first, for the audit panel. */
  recentChanges: OperationsSettingsChangeView[];
};

export type OperationsSettingsChangeView = {
  id: string;
  setting: string;
  previousValue: string | null;
  newValue: string;
  createdAt: Date;
  changedBy: { id: string; name: string | null } | null;
};

const RECENT_CHANGE_LIMIT = 20;

@Injectable()
export class OperationsSettingsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * The window the next offer will be sold under.
   *
   * Takes an optional transaction client so the offer-creation path can read it
   * inside the same transaction that writes the snapshot: the value an offer
   * records and the value that was in force when it was created are then the
   * same value, not two reads with a gap between them.
   */
  async getUnviewedOfferRefundWindowHours(
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<number> {
    const row = await client.operationsSettings.findUnique({
      where: { id: OPERATIONS_SETTINGS_ID },
      select: { unviewedOfferRefundWindowHours: true },
    });

    return row?.unviewedOfferRefundWindowHours ?? DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS;
  }

  async getForAdmin(): Promise<OperationsSettingsView> {
    const [row, changes] = await Promise.all([
      this.prisma.operationsSettings.findUnique({
        where: { id: OPERATIONS_SETTINGS_ID },
        select: settingsSelect,
      }),
      // This screen's own audit panel shows the window's history and nothing
      // else. The scheduler switches share the table and have their own panel;
      // mixing the two lists would make either one harder to read.
      this.prisma.operationsSettingsChange.findMany({
        where: { setting: UNVIEWED_OFFER_REFUND_WINDOW_SETTING },
        orderBy: { createdAt: 'desc' },
        take: RECENT_CHANGE_LIMIT,
        select: {
          id: true,
          setting: true,
          previousValue: true,
          newValue: true,
          createdAt: true,
          changedBy: { select: { id: true, name: true } },
        },
      }),
    ]);

    const lastChange = changes[0] ?? null;

    const windowHours =
      row?.unviewedOfferRefundWindowHours ?? DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS;

    return {
      configured: lastChange !== null,
      unviewedOfferRefundWindowHours: windowHours,
      minUnviewedOfferRefundWindowHours: MIN_UNVIEWED_OFFER_REFUND_WINDOW_HOURS,
      maxUnviewedOfferRefundWindowHours: MAX_UNVIEWED_OFFER_REFUND_WINDOW_HOURS,
      defaultUnviewedOfferRefundWindowHours: DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS,
      unviewedOfferRefundNotice: unviewedOfferRefundNotice(windowHours),
      updatedAt: lastChange?.createdAt ?? null,
      updatedBy: lastChange?.changedBy ?? null,
      recentChanges: changes,
    };
  }

  /**
   * Saves the settings and records what changed.
   *
   * The upsert and the audit row commit together, so a change to a commercial
   * term with nobody's name on it cannot exist. An audit row is written only
   * when the value actually moves — a save that re-submits the same number is a
   * no-op the trail should not pretend was a decision — and `previousValue` is
   * NULL exactly once, on the first save, when the effective value was the
   * product default rather than something an operator chose.
   *
   * Serializable, because the trail is a chain: two operators saving at the
   * same moment under a weaker level could both read the old value and each
   * record themselves as having changed it from that, leaving two rows claiming
   * the same predecessor and no record of the intermediate state. Under
   * Serializable one of them replays and records what the other actually left
   * behind.
   *
   * `changedById` is the authenticated operator, passed by the controller and
   * never read from the payload.
   */
  async save(
    dto: SaveOperationsSettingsDto,
    changedById: string,
  ): Promise<OperationsSettingsView> {
    const nextWindowHours = dto.unviewedOfferRefundWindowHours;

    await runSerializable(
      this.prisma,
      async (tx) => {
        const current = await tx.operationsSettings.findUnique({
          where: { id: OPERATIONS_SETTINGS_ID },
          select: { unviewedOfferRefundWindowHours: true },
        });

        await tx.operationsSettings.upsert({
          where: { id: OPERATIONS_SETTINGS_ID },
          create: {
            id: OPERATIONS_SETTINGS_ID,
            unviewedOfferRefundWindowHours: nextWindowHours,
            updatedById: changedById,
          },
          update: {
            unviewedOfferRefundWindowHours: nextWindowHours,
            updatedById: changedById,
          },
        });

        if (current?.unviewedOfferRefundWindowHours === nextWindowHours) {
          return;
        }

        await tx.operationsSettingsChange.create({
          data: {
            setting: UNVIEWED_OFFER_REFUND_WINDOW_SETTING,
            previousValue:
              current === null ? null : String(current.unviewedOfferRefundWindowHours),
            newValue: String(nextWindowHours),
            changedById,
          },
        });
      },
      { label: 'operationsSettings.save' },
    );

    return this.getForAdmin();
  }
}
