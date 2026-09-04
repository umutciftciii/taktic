import { SupportTicketStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { ArrayNotEmpty, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { SUPPORT_TICKET_PAGE_MAX_SIZE } from '../support-tickets.config';

function toInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The statuses named by `?status=`, in whichever shape the caller wrote them.
 *
 * Three shapes reach here and all three mean the same thing:
 *
 *     ?status=OPEN                    one status, the original contract
 *     ?status=OPEN,IN_PROGRESS        a comma-separated set
 *     ?status=OPEN&status=IN_PROGRESS repeated, as Express parses it into an array
 *
 * The single-status form is the one every existing link and the filter form
 * itself still send, and it comes out of here as a one-element list — the
 * widening is in what the field can now say, never in what it used to say.
 *
 * Duplicates are collapsed and order is dropped: `status=OPEN,OPEN` is the same
 * filter as `status=OPEN`, and the list's order is `lastActivityAt` regardless.
 * Empty and whitespace-only entries become no filter at all rather than a
 * filter matching nothing, which is what "?status=" has always meant.
 *
 * Unknown values are deliberately *not* dropped here. `@IsEnum` below rejects
 * the request, so a typo like `?status=OPENN` is a 400 that names the field
 * rather than a silent full-table listing.
 */
function toStatusList(value: unknown): SupportTicketStatus[] | undefined {
  const raw = Array.isArray(value) ? value : [value];

  const statuses = raw
    .flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : []))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return statuses.length > 0 ? (Array.from(new Set(statuses)) as SupportTicketStatus[]) : undefined;
}

/**
 * The admin list's query: an optional set of statuses and a page.
 *
 * There is no customer filter and no free-text search in this version. Both are
 * real asks and neither is this one, and a half-built search that only matches
 * a subject would be worse than none.
 */
export class ListSupportTicketsDto {
  /**
   * Named `status` rather than `statuses` on purpose: the query parameter is
   * part of a contract that links already carry, and renaming it would break
   * every one of them to gain nothing but a plural.
   */
  @IsOptional()
  @Transform(({ value }) => toStatusList(value))
  @ArrayNotEmpty()
  @IsEnum(SupportTicketStatus, { each: true })
  status?: SupportTicketStatus[];

  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  @Max(SUPPORT_TICKET_PAGE_MAX_SIZE)
  pageSize?: number;
}
