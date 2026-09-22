import { AdminPermission } from '@prisma/client';

/**
 * Every admin route and the one capability it needs — the canonical mapping of
 * `docs/superpowers/plans/2026-09-22-pr0-route-permission-map.md`, in the form
 * a test can read.
 *
 * This file is not documentation that happens to be typed: it is the contract
 * `route-permission-map.spec.ts` enforces in both directions. A guarded admin
 * route that appears in the running application but not here fails the test, and
 * an entry here that names no route fails it too. A route can therefore neither
 * be added without a decision about who may reach it, nor left behind when it is
 * removed.
 *
 * What is deliberately *not* here:
 *
 *  - The two root routes (`POST /users`, `POST /users/:id/invite-link`) and the
 *    role-management routes. They keep `@Roles(UserRole.SUPER_ADMIN)` because
 *    their capabilities are absent from `AdminPermission` altogether (RG-7
 *    §12.1) and so cannot be delegated to any role.
 *  - The 27 routes whose `@Roles(...)` names a marketplace role alongside
 *    SUPER_ADMIN. Those are customer and provider routes; an ADMIN does not
 *    reach them, by decision (§12.2).
 *  - The 21 routes guarded only by `ProviderAccessGuard`. They stay outside the
 *    permission model entirely — no admin impersonation (§12.2) — and the test
 *    asserts an ADMIN holding every permission is still refused.
 *
 * `path` is the route as Nest registers it, parameters and all.
 */
export type AdminRoutePermission = {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  permission: AdminPermission;
};

export const ADMIN_ROUTE_PERMISSIONS: readonly AdminRoutePermission[] = [
  { method: 'GET', path: '/admin/campaigns', permission: AdminPermission.CAMPAIGNS_READ },
  { method: 'GET', path: '/admin/categories', permission: AdminPermission.CATALOG_READ },
  { method: 'GET', path: '/admin/categories/:slug', permission: AdminPermission.CATALOG_READ },
  { method: 'POST', path: '/admin/campaigns', permission: AdminPermission.CAMPAIGNS_WRITE },
  { method: 'GET', path: '/admin/campaigns/:id', permission: AdminPermission.CAMPAIGNS_READ },
  { method: 'POST', path: '/admin/campaigns/:id/end', permission: AdminPermission.CAMPAIGNS_LIFECYCLE },
  { method: 'GET', path: '/admin/campaigns/:id/evaluation-events', permission: AdminPermission.CAMPAIGNS_READ },
  { method: 'POST', path: '/admin/campaigns/:id/evaluation-events/:eventId/retry', permission: AdminPermission.CAMPAIGN_EVENT_RETRY },
  { method: 'POST', path: '/admin/campaigns/:id/pause', permission: AdminPermission.CAMPAIGNS_LIFECYCLE },
  { method: 'GET', path: '/admin/campaigns/:id/redemptions', permission: AdminPermission.CAMPAIGNS_READ },
  { method: 'POST', path: '/admin/campaigns/:id/redemptions/:redemptionId/revoke', permission: AdminPermission.CAMPAIGN_REDEMPTION_REVOKE },
  { method: 'POST', path: '/admin/campaigns/:id/resume', permission: AdminPermission.CAMPAIGNS_LIFECYCLE },
  { method: 'POST', path: '/admin/campaigns/:id/versions', permission: AdminPermission.CAMPAIGNS_WRITE },
  { method: 'POST', path: '/admin/campaigns/:id/versions/:versionNumber/activate', permission: AdminPermission.CAMPAIGNS_LIFECYCLE },
  { method: 'POST', path: '/admin/campaigns/validate', permission: AdminPermission.CAMPAIGNS_READ },
  { method: 'GET', path: '/admin/offer-packages', permission: AdminPermission.CREDIT_PACKAGES_READ },
  { method: 'GET', path: '/admin/offer-packages/:id', permission: AdminPermission.CREDIT_PACKAGES_READ },
  { method: 'GET', path: '/admin/offer-packages/unlimited-eligible-categories', permission: AdminPermission.CREDIT_PACKAGES_READ },
  { method: 'GET', path: '/admin/showcase/cards', permission: AdminPermission.SHOWCASE_CARDS_READ },
  { method: 'GET', path: '/admin/showcase/cards/:cardId', permission: AdminPermission.SHOWCASE_CARDS_READ },
  { method: 'POST', path: '/admin/showcase/cards/:cardId/suspend', permission: AdminPermission.SHOWCASE_CARDS_MODERATE },
  { method: 'POST', path: '/admin/showcase/cards/:cardId/unsuspend', permission: AdminPermission.SHOWCASE_CARDS_MODERATE },
  { method: 'GET', path: '/admin/showcase/leads', permission: AdminPermission.SHOWCASE_LEADS_READ },
  { method: 'GET', path: '/admin/showcase/leads/:leadId', permission: AdminPermission.SHOWCASE_LEADS_READ },
  { method: 'GET', path: '/admin/showcase/packages', permission: AdminPermission.SHOWCASE_PACKAGES_READ },
  { method: 'POST', path: '/admin/showcase/packages', permission: AdminPermission.SHOWCASE_PACKAGES_WRITE },
  { method: 'GET', path: '/admin/showcase/packages/:packageId', permission: AdminPermission.SHOWCASE_PACKAGES_READ },
  { method: 'PATCH', path: '/admin/showcase/packages/:packageId', permission: AdminPermission.SHOWCASE_PACKAGES_WRITE },
  { method: 'GET', path: '/admin/showcase/placements', permission: AdminPermission.SHOWCASE_PLACEMENTS_READ },
  { method: 'GET', path: '/admin/showcase/placements/:placementId', permission: AdminPermission.SHOWCASE_PLACEMENTS_READ },
  { method: 'POST', path: '/admin/showcase/placements/:placementId/cancel', permission: AdminPermission.SHOWCASE_PLACEMENT_CANCEL },
  { method: 'POST', path: '/admin/showcase/placements/:placementId/resume', permission: AdminPermission.SHOWCASE_PLACEMENTS_MODERATE },
  { method: 'POST', path: '/admin/showcase/placements/:placementId/suspend', permission: AdminPermission.SHOWCASE_PLACEMENTS_MODERATE },
  { method: 'GET', path: '/admin/showcase/price-terms-acceptances', permission: AdminPermission.SHOWCASE_TERMS_ACCEPTANCES_READ },
  { method: 'GET', path: '/admin/showcase/versions', permission: AdminPermission.SHOWCASE_REVIEW_READ },
  { method: 'GET', path: '/admin/showcase/versions/:versionId', permission: AdminPermission.SHOWCASE_REVIEW_READ },
  { method: 'POST', path: '/admin/showcase/versions/:versionId/approve', permission: AdminPermission.SHOWCASE_REVIEW_DECIDE },
  { method: 'POST', path: '/admin/showcase/versions/:versionId/reject', permission: AdminPermission.SHOWCASE_REVIEW_DECIDE },
  { method: 'GET', path: '/admin/support/tickets', permission: AdminPermission.SUPPORT_READ },
  { method: 'GET', path: '/admin/support/tickets/:ticketId', permission: AdminPermission.SUPPORT_READ },
  { method: 'POST', path: '/admin/support/tickets/:ticketId/messages', permission: AdminPermission.SUPPORT_WRITE },
  { method: 'POST', path: '/admin/support/tickets/:ticketId/status', permission: AdminPermission.SUPPORT_WRITE },
  { method: 'POST', path: '/admin/uploads/category-image', permission: AdminPermission.UPLOADS_WRITE },
  { method: 'POST', path: '/categories', permission: AdminPermission.CATEGORIES_WRITE },
  { method: 'GET', path: '/categories/:categoryId/provider-invites', permission: AdminPermission.PROVIDER_INVITES_READ },
  { method: 'POST', path: '/categories/:categoryId/provider-invites', permission: AdminPermission.PROVIDER_INVITES_ISSUE },
  { method: 'POST', path: '/categories/:categoryId/provider-invites/:inviteId/revoke', permission: AdminPermission.PROVIDER_INVITES_REVOKE },
  { method: 'GET', path: '/categories/:categoryId/questions', permission: AdminPermission.QUESTIONS_READ },
  { method: 'POST', path: '/categories/:categoryId/questions', permission: AdminPermission.QUESTIONS_WRITE },
  { method: 'DELETE', path: '/categories/:id', permission: AdminPermission.CATEGORIES_DELETE },
  { method: 'PATCH', path: '/categories/:id', permission: AdminPermission.CATEGORIES_WRITE },
  { method: 'PATCH', path: '/categories/:id/status', permission: AdminPermission.CATEGORIES_STATUS },
  { method: 'GET', path: '/company-settings', permission: AdminPermission.COMPANY_SETTINGS_READ },
  { method: 'PUT', path: '/company-settings', permission: AdminPermission.COMPANY_SETTINGS_WRITE },
  { method: 'POST', path: '/credit-packages', permission: AdminPermission.CREDIT_PACKAGES_WRITE },
  { method: 'PATCH', path: '/credit-packages/:id', permission: AdminPermission.CREDIT_PACKAGES_WRITE },
  { method: 'PATCH', path: '/credit-packages/:id/status', permission: AdminPermission.CREDIT_PACKAGES_STATUS },
  { method: 'GET', path: '/customers', permission: AdminPermission.CUSTOMERS_READ },
  { method: 'GET', path: '/customers/:id', permission: AdminPermission.CUSTOMERS_READ },
  { method: 'POST', path: '/customers/:id/activation-link', permission: AdminPermission.CUSTOMER_ACTIVATION_LINK_ISSUE },
  { method: 'GET', path: '/customers/:id/notes', permission: AdminPermission.CUSTOMER_NOTES_READ },
  { method: 'POST', path: '/customers/:id/notes', permission: AdminPermission.CUSTOMER_NOTES_WRITE },
  { method: 'PATCH', path: '/customers/:id/status', permission: AdminPermission.CUSTOMERS_STATUS },
  { method: 'GET', path: '/dashboard/admin-summary', permission: AdminPermission.DASHBOARD_READ },
  { method: 'GET', path: '/finance/analytics', permission: AdminPermission.FINANCE_READ },
  { method: 'GET', path: '/finance/credit-ledger', permission: AdminPermission.FINANCE_LEDGER_READ },
  { method: 'GET', path: '/finance/providers', permission: AdminPermission.FINANCE_READ },
  { method: 'GET', path: '/finance/summary', permission: AdminPermission.FINANCE_READ },
  { method: 'GET', path: '/notification-logs', permission: AdminPermission.NOTIFICATION_LOGS_READ },
  { method: 'GET', path: '/notification-logs/:id', permission: AdminPermission.NOTIFICATION_LOGS_READ },
  { method: 'POST', path: '/notification-logs/:id/retry', permission: AdminPermission.NOTIFICATION_RETRY },
  { method: 'GET', path: '/offers', permission: AdminPermission.OFFERS_READ },
  { method: 'GET', path: '/offers/:id', permission: AdminPermission.OFFERS_READ },
  { method: 'POST', path: '/offers/:id/refund-credit', permission: AdminPermission.OFFER_REFUND_MANUAL },
  { method: 'PATCH', path: '/offers/:id/status', permission: AdminPermission.OFFERS_STATUS },
  { method: 'GET', path: '/offers/refund-scan', permission: AdminPermission.OFFER_REFUND_SCAN_READ },
  { method: 'POST', path: '/offers/refund-scan/execute', permission: AdminPermission.OFFER_REFUND_EXECUTE },
  { method: 'GET', path: '/operations-settings', permission: AdminPermission.OPERATIONS_SETTINGS_READ },
  { method: 'PUT', path: '/operations-settings', permission: AdminPermission.OPERATIONS_SETTINGS_WRITE },
  { method: 'GET', path: '/operations-settings/campaign-engine', permission: AdminPermission.OPERATIONS_SETTINGS_READ },
  { method: 'PUT', path: '/operations-settings/campaign-engine', permission: AdminPermission.CAMPAIGN_ENGINE_TOGGLE },
  { method: 'GET', path: '/operations-settings/marketplace-publish', permission: AdminPermission.OPERATIONS_SETTINGS_READ },
  { method: 'PUT', path: '/operations-settings/marketplace-publish', permission: AdminPermission.MARKETPLACE_PUBLISH_WRITE },
  { method: 'GET', path: '/operations-settings/provider-reviews', permission: AdminPermission.OPERATIONS_SETTINGS_READ },
  { method: 'PUT', path: '/operations-settings/provider-reviews', permission: AdminPermission.PROVIDER_REVIEWS_SETTING_WRITE },
  { method: 'GET', path: '/operations-settings/schedulers', permission: AdminPermission.OPERATIONS_SETTINGS_READ },
  { method: 'PUT', path: '/operations-settings/schedulers/:job', permission: AdminPermission.SCHEDULERS_WRITE },
  { method: 'GET', path: '/package-purchases', permission: AdminPermission.PACKAGE_PURCHASES_READ },
  { method: 'GET', path: '/package-purchases/:id', permission: AdminPermission.PACKAGE_PURCHASES_READ },
  { method: 'PATCH', path: '/package-purchases/:id/status', permission: AdminPermission.PACKAGE_PURCHASE_STATUS_WRITE },
  { method: 'GET', path: '/payments/config', permission: AdminPermission.PAYMENTS_CONFIG_READ },
  { method: 'GET', path: '/provider-reviews/:reviewId', permission: AdminPermission.PROVIDER_REVIEWS_READ },
  { method: 'POST', path: '/provider-reviews/:reviewId/moderate', permission: AdminPermission.PROVIDER_REVIEWS_MODERATE },
  { method: 'POST', path: '/provider-reviews/:reviewId/reports/dismiss', permission: AdminPermission.PROVIDER_REVIEWS_MODERATE },
  { method: 'GET', path: '/provider-reviews/reports', permission: AdminPermission.PROVIDER_REVIEWS_READ },
  { method: 'GET', path: '/providers', permission: AdminPermission.PROVIDERS_READ },
  { method: 'PATCH', path: '/providers/:id', permission: AdminPermission.PROVIDERS_WRITE },
  { method: 'PATCH', path: '/providers/:id/status', permission: AdminPermission.PROVIDERS_MODERATE },
  { method: 'GET', path: '/providers/:providerId/admin-detail', permission: AdminPermission.PROVIDERS_READ_DETAIL },
  { method: 'POST', path: '/providers/:providerId/claim-invitations', permission: AdminPermission.PROVIDER_CLAIM_INVITE_ISSUE },
  { method: 'POST', path: '/providers/:providerId/credits/deduct', permission: AdminPermission.CREDITS_DEDUCT },
  { method: 'POST', path: '/providers/:providerId/credits/grant', permission: AdminPermission.CREDITS_GRANT },
  { method: 'GET', path: '/providers/:providerId/service-categories', permission: AdminPermission.PROVIDERS_READ },
  { method: 'POST', path: '/providers/:providerId/service-categories', permission: AdminPermission.PROVIDER_CATEGORIES_WRITE },
  { method: 'DELETE', path: '/providers/:providerId/service-categories/:categoryId', permission: AdminPermission.PROVIDER_CATEGORIES_WRITE },
  { method: 'DELETE', path: '/questions/:id', permission: AdminPermission.QUESTIONS_DELETE },
  { method: 'PATCH', path: '/questions/:id', permission: AdminPermission.QUESTIONS_WRITE },
  { method: 'PUT', path: '/questions/:id/conditions', permission: AdminPermission.QUESTIONS_WRITE },
  { method: 'PUT', path: '/questions/:id/router-rules', permission: AdminPermission.QUESTIONS_WRITE },
  { method: 'PATCH', path: '/questions/:id/status', permission: AdminPermission.QUESTIONS_WRITE },
  { method: 'GET', path: '/service-requests', permission: AdminPermission.REQUESTS_READ },
  { method: 'GET', path: '/service-requests/:id', permission: AdminPermission.REQUESTS_READ },
  { method: 'POST', path: '/service-requests/:id/recalculate-quality', permission: AdminPermission.REQUESTS_QUALITY_RECALC },
  { method: 'POST', path: '/service-requests/:id/reopen', permission: AdminPermission.REQUESTS_REOPEN },
  { method: 'GET', path: '/service-requests/:id/reports', permission: AdminPermission.REQUEST_REPORTS_READ },
  { method: 'POST', path: '/service-requests/:id/reports/resolve', permission: AdminPermission.REQUEST_REPORTS_RESOLVE },
  { method: 'PATCH', path: '/service-requests/:id/status', permission: AdminPermission.REQUESTS_STATUS },
  { method: 'GET', path: '/service-requests/:requestId/contact-reveal', permission: AdminPermission.CONTACT_REVEAL_READ },
  { method: 'GET', path: '/service-requests/reports', permission: AdminPermission.REQUEST_REPORTS_READ },
  { method: 'GET', path: '/users', permission: AdminPermission.ADMIN_USERS_READ },
  { method: 'GET', path: '/users/:id', permission: AdminPermission.ADMIN_USERS_READ },
  { method: 'PATCH', path: '/users/:id/status', permission: AdminPermission.ADMIN_USERS_STATUS },
];

/**
 * The routes that stay on `@Roles(UserRole.SUPER_ADMIN)` because the capability
 * they carry has no permission value and never will (RG-7 §12.1).
 *
 * Listed so the test can assert the complement: an ADMIN holding the whole
 * catalogue is refused on every one of them.
 */
export const ROOT_ONLY_ROUTES: readonly { method: AdminRoutePermission['method']; path: string }[] = [
  // Creating a staff account, and minting the link that activates it.
  { method: 'POST', path: '/users' },
  { method: 'POST', path: '/users/:id/invite-link' },
  // Defining roles and handing them out: the capability that would let a role
  // widen itself, which is why it is not a permission.
  { method: 'GET', path: '/admin/roles' },
  { method: 'POST', path: '/admin/roles' },
  { method: 'GET', path: '/admin/roles/:id' },
  { method: 'PATCH', path: '/admin/roles/:id' },
  { method: 'PUT', path: '/admin/roles/:id/permissions' },
  { method: 'GET', path: '/admin/permissions' },
  { method: 'POST', path: '/admin/users/:userId/roles' },
  { method: 'DELETE', path: '/admin/users/:userId/roles/:roleId' },
];
