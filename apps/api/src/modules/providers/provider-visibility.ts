import { ProviderStatus } from '@prisma/client';

/**
 * Only an approved provider is a public entity. Everything else — a draft, an
 * application under review, a rejected or suspended profile — is private
 * moderation state and must not be discoverable by id.
 *
 * Deliberately an allow-list: a status added later stays private until someone
 * consciously decides it should be public.
 *
 * In its own file, with no imports from this module, because the reviews
 * service asks the same question and `ProvidersService` in turn asks the
 * reviews service for the dashboard's summary. Two service files importing
 * each other is a cycle at load time, and a class token that is `undefined`
 * while Nest reads the constructor's decorators cannot be injected — the pure
 * function has to live where neither service is.
 */
const PUBLICLY_VISIBLE_STATUSES: ReadonlySet<ProviderStatus> = new Set([ProviderStatus.APPROVED]);

/** The same allow-list as a `where: { status: { in } }` argument, for the directory query. */
export const PUBLIC_DIRECTORY_STATUSES: readonly ProviderStatus[] = [...PUBLICLY_VISIBLE_STATUSES];

export function isPubliclyVisibleProvider(status: ProviderStatus): boolean {
  return PUBLICLY_VISIBLE_STATUSES.has(status);
}
