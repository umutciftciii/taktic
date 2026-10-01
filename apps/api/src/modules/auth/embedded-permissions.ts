import { AdminPermission } from '@prisma/client';
import { hasPermission } from './admin-permissions';
import type { AuthUser } from './auth.types';

/**
 * Whether an admin response may carry data that belongs to *another* domain's
 * read permission (API-ADMIN-CROSS-DOMAIN-PROJECTION-RBAC-001).
 *
 * A route's permission opens the route and its own subject — a provider's
 * profile, a customer's account, an offer. It does not open what the subject
 * happens to be joined to: the provider's balance is the ledger's
 * (FINANCE_LEDGER_READ), its purchases are PACKAGE_PURCHASES_READ's, a
 * request owner's contact is REQUESTS_READ's. A response built for one
 * permission therefore asks this function, per embedded block, whether the
 * caller also holds the permission that block would need on its own route.
 *
 * The answer decides presence, never value. A block the caller may not read is
 * left out of the body — the key is absent — rather than sent as `null`, `0`
 * or `[]`: those are values a reader cannot tell apart from "there is none",
 * and an empty list where the real list has rows is a statement the data does
 * not support. Which blocks are absent follows from the caller's own
 * permissions, which `GET /admin/me/permissions` already tells it.
 *
 * Several permissions mean *all* of them, as everywhere else. A SUPER_ADMIN
 * holds every permission (`hasPermission`), so its view is the full one.
 */
export function mayEmbed(
  user: Pick<AuthUser, 'role' | 'permissions'> | null | undefined,
  ...required: AdminPermission[]
): boolean {
  if (!user) return false;
  return hasPermission({ role: user.role, permissions: user.permissions ?? [] }, required);
}

/**
 * Whether a staff member's e-mail may travel with the record they acted on
 * (API-ADMIN-CROSS-DOMAIN-PROJECTION-RBAC-002).
 *
 * Who wrote a note, granted a credit, decided a review or cancelled a request
 * is part of that record, and its route's permission shows it: the actor's id
 * and name. The actor's address is the staff directory's — the one place that
 * lists staff accounts, read with ADMIN_USERS_READ — and an audit row is not a
 * second way into it. Without that permission the `email` key is absent; the
 * id and the name, which carry the audit, stay.
 */
export function mayEmbedStaffEmail(user: Pick<AuthUser, 'role' | 'permissions'> | null | undefined): boolean {
  return mayEmbed(user, AdminPermission.ADMIN_USERS_READ);
}

/** The Prisma select of a staff actor: id and name always, the e-mail per {@link mayEmbedStaffEmail}. */
export function staffActorSelect(user: Pick<AuthUser, 'role' | 'permissions'> | null | undefined) {
  return { select: { id: true, name: true, email: mayEmbedStaffEmail(user) } } as const;
}
