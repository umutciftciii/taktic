import type { DataColumn } from '../components/data-table';
import type { CustomerSortField } from './api';
import { CUSTOMER_SORT_FIELDS } from './api';

/**
 * The screen side of API-ADMIN-CROSS-DOMAIN-PROJECTION-RBAC-001.
 *
 * An admin response carries another domain's data — a provider's balance,
 * offers and purchases, a customer's requests and offers, a request owner's
 * contact — only for a session holding that domain's read permission, and
 * leaves the key out otherwise. A screen that drew the column anyway would
 * print `0` or `—` for a value the API never stated, so a column, a figure or
 * a control is drawn only where the session may read what it shows. These are
 * the rules the list screens share; the detail screens apply the same idea
 * block by block.
 */

/** Keeps every column whose key is not gated, and a gated one only when its gate is open. */
export function gateColumns(columns: readonly DataColumn[], gates: Readonly<Record<string, boolean>>): DataColumn[] {
  return columns.filter((column) => gates[column.key] ?? true);
}

/** Which of a customer row's activity figures the session may read. */
export type CustomerFigures = { requests: boolean; offers: boolean };

const CUSTOMER_REQUEST_SORT_FIELDS: ReadonlySet<CustomerSortField> = new Set(['lastRequestAt', 'requestCount']);
const CUSTOMER_OFFER_SORT_FIELDS: ReadonlySet<CustomerSortField> = new Set(['offerCount', 'acceptedOfferCount']);

/**
 * The sorts the API accepts from this session: a sort on a figure the session
 * may not read is refused (403), because the order of the rows would answer
 * what the missing column does not.
 */
export function customerSortFields(figures: CustomerFigures): CustomerSortField[] {
  return CUSTOMER_SORT_FIELDS.filter(
    (field) =>
      (figures.requests || !CUSTOMER_REQUEST_SORT_FIELDS.has(field)) &&
      (figures.offers || !CUSTOMER_OFFER_SORT_FIELDS.has(field)),
  );
}

/** The API's own default: the last request first, or — without the requests — the newest account. */
export function customerDefaultSort(figures: CustomerFigures): CustomerSortField {
  return figures.requests ? 'lastRequestAt' : 'createdAt';
}

/** The customer list's columns that show request (city, count, last) or offer figures. */
export function customerColumnGates(figures: CustomerFigures): Record<string, boolean> {
  return {
    city: figures.requests,
    requests: figures.requests,
    lastRequest: figures.requests,
    offers: figures.offers,
    accepted: figures.offers,
  };
}

/** The provider list's figure columns, each its own domain's. */
export function providerColumnGates(figures: { credit: boolean; offers: boolean; packages: boolean }): Record<string, boolean> {
  return { credit: figures.credit, offers: figures.offers, packages: figures.packages };
}
