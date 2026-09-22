-- PR-0 (Migration H): permission-based admin authorization.
--
-- Additive only. No DML, no ALTER COLUMN, no DROP: every existing SUPER_ADMIN
-- account keeps its role and, because a SUPER_ADMIN holds every permission
-- implicitly, keeps every capability it had the moment before this ran. Nothing
-- is backfilled, because there is nothing true to backfill: no account has ever
-- held a role assignment.
--
-- Three things arrive together and the order matters:
--
--  1. "AdminPermission" — the closed catalogue. Its 76 values are the
--     route-level mapping in
--     docs/superpowers/plans/2026-09-22-pr0-route-permission-map.md. Three
--     capabilities are deliberately absent (RG-7 §12.1) — defining roles,
--     creating staff accounts, minting their invite links — so that no
--     AdminRolePermission row can ever carry them: the literal does not exist
--     in the type and PostgreSQL refuses it.
--
--  2. "UserRole" gains ADMIN. `ALTER TYPE … ADD VALUE` commits before the new
--     value may be used, which is why nothing below reads or writes it.
--
--  3. The three tables plus their audit log.
--
-- The partial unique index at the end is the one thing Prisma cannot express:
-- a user may hold a role once *while the assignment is live*, and any number of
-- times across revoked history.
-- CreateEnum
CREATE TYPE "AdminPermission" AS ENUM ('DASHBOARD_READ', 'CAMPAIGNS_READ', 'CAMPAIGNS_WRITE', 'CAMPAIGNS_LIFECYCLE', 'CAMPAIGN_REDEMPTION_REVOKE', 'CAMPAIGN_EVENT_RETRY', 'CAMPAIGN_ENGINE_TOGGLE', 'CATEGORIES_WRITE', 'CATEGORIES_STATUS', 'CATEGORIES_DELETE', 'QUESTIONS_READ', 'QUESTIONS_WRITE', 'QUESTIONS_DELETE', 'COMPANY_SETTINGS_READ', 'COMPANY_SETTINGS_WRITE', 'OPERATIONS_SETTINGS_READ', 'OPERATIONS_SETTINGS_WRITE', 'SCHEDULERS_WRITE', 'MARKETPLACE_PUBLISH_WRITE', 'PROVIDER_REVIEWS_SETTING_WRITE', 'CREDIT_PACKAGES_READ', 'CREDIT_PACKAGES_WRITE', 'CREDIT_PACKAGES_STATUS', 'CREDITS_GRANT', 'CREDITS_DEDUCT', 'FINANCE_READ', 'FINANCE_LEDGER_READ', 'PACKAGE_PURCHASES_READ', 'PACKAGE_PURCHASE_STATUS_WRITE', 'PAYMENTS_CONFIG_READ', 'OFFERS_READ', 'OFFERS_STATUS', 'OFFER_REFUND_SCAN_READ', 'OFFER_REFUND_EXECUTE', 'OFFER_REFUND_MANUAL', 'REQUESTS_READ', 'REQUESTS_STATUS', 'REQUESTS_QUALITY_RECALC', 'REQUESTS_REOPEN', 'REQUEST_REPORTS_READ', 'REQUEST_REPORTS_RESOLVE', 'CONTACT_REVEAL_READ', 'CUSTOMERS_READ', 'CUSTOMERS_STATUS', 'CUSTOMER_NOTES_READ', 'CUSTOMER_NOTES_WRITE', 'CUSTOMER_ACTIVATION_LINK_ISSUE', 'PROVIDERS_READ', 'PROVIDERS_READ_DETAIL', 'PROVIDERS_WRITE', 'PROVIDERS_MODERATE', 'PROVIDER_CATEGORIES_WRITE', 'PROVIDER_CLAIM_INVITE_ISSUE', 'PROVIDER_INVITES_READ', 'PROVIDER_INVITES_ISSUE', 'PROVIDER_INVITES_REVOKE', 'PROVIDER_REVIEWS_READ', 'PROVIDER_REVIEWS_MODERATE', 'SHOWCASE_PACKAGES_READ', 'SHOWCASE_PACKAGES_WRITE', 'SHOWCASE_PLACEMENTS_READ', 'SHOWCASE_PLACEMENTS_MODERATE', 'SHOWCASE_PLACEMENT_CANCEL', 'SHOWCASE_LEADS_READ', 'SHOWCASE_TERMS_ACCEPTANCES_READ', 'SHOWCASE_REVIEW_READ', 'SHOWCASE_REVIEW_DECIDE', 'SHOWCASE_CARDS_READ', 'SHOWCASE_CARDS_MODERATE', 'SUPPORT_READ', 'SUPPORT_WRITE', 'NOTIFICATION_LOGS_READ', 'NOTIFICATION_RETRY', 'UPLOADS_WRITE', 'ADMIN_USERS_READ', 'ADMIN_USERS_STATUS');
-- CreateEnum
CREATE TYPE "AdminRoleAuditAction" AS ENUM ('ROLE_CREATED', 'ROLE_UPDATED', 'ROLE_PERMISSIONS_REPLACED', 'ROLE_DEACTIVATED', 'ROLE_REACTIVATED', 'ASSIGNMENT_GRANTED', 'ASSIGNMENT_REVOKED');
-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'ADMIN';
-- CreateTable
CREATE TABLE "AdminRole" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdminRole_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "AdminRolePermission" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permission" "AdminPermission" NOT NULL,
    CONSTRAINT "AdminRolePermission_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "AdminRoleAssignment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "assignedById" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    CONSTRAINT "AdminRoleAssignment_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "AdminRoleAuditLog" (
    "id" TEXT NOT NULL,
    "action" "AdminRoleAuditAction" NOT NULL,
    "roleId" TEXT,
    "targetUserId" TEXT,
    "actorId" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminRoleAuditLog_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "AdminRole_key_key" ON "AdminRole"("key");
-- CreateIndex
CREATE INDEX "AdminRole_isActive_name_idx" ON "AdminRole"("isActive", "name");
-- CreateIndex
CREATE INDEX "AdminRole_createdById_idx" ON "AdminRole"("createdById");
-- CreateIndex
CREATE INDEX "AdminRolePermission_permission_idx" ON "AdminRolePermission"("permission");
-- CreateIndex
CREATE UNIQUE INDEX "AdminRolePermission_roleId_permission_key" ON "AdminRolePermission"("roleId", "permission");
-- CreateIndex
CREATE INDEX "AdminRoleAssignment_userId_revokedAt_idx" ON "AdminRoleAssignment"("userId", "revokedAt");
-- CreateIndex
CREATE INDEX "AdminRoleAssignment_roleId_revokedAt_idx" ON "AdminRoleAssignment"("roleId", "revokedAt");
-- CreateIndex
CREATE INDEX "AdminRoleAssignment_assignedById_idx" ON "AdminRoleAssignment"("assignedById");
-- CreateIndex
CREATE INDEX "AdminRoleAuditLog_roleId_createdAt_idx" ON "AdminRoleAuditLog"("roleId", "createdAt");
-- CreateIndex
CREATE INDEX "AdminRoleAuditLog_targetUserId_createdAt_idx" ON "AdminRoleAuditLog"("targetUserId", "createdAt");
-- CreateIndex
CREATE INDEX "AdminRoleAuditLog_actorId_createdAt_idx" ON "AdminRoleAuditLog"("actorId", "createdAt");
-- CreateIndex
CREATE INDEX "AdminRoleAuditLog_createdAt_idx" ON "AdminRoleAuditLog"("createdAt");
-- AddForeignKey
ALTER TABLE "AdminRole" ADD CONSTRAINT "AdminRole_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "AdminRolePermission" ADD CONSTRAINT "AdminRolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "AdminRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "AdminRoleAssignment" ADD CONSTRAINT "AdminRoleAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "AdminRoleAssignment" ADD CONSTRAINT "AdminRoleAssignment_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "AdminRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "AdminRoleAssignment" ADD CONSTRAINT "AdminRoleAssignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "AdminRoleAssignment" ADD CONSTRAINT "AdminRoleAssignment_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "AdminRoleAuditLog" ADD CONSTRAINT "AdminRoleAuditLog_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "AdminRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "AdminRoleAuditLog" ADD CONSTRAINT "AdminRoleAuditLog_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "AdminRoleAuditLog" ADD CONSTRAINT "AdminRoleAuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The live-assignment rule, as a database guarantee rather than a service
-- convention: (userId, roleId) is unique among rows that have not been revoked.
-- Two concurrent grants of the same role therefore cannot both land, and the
-- permission read never has to de-duplicate.
CREATE UNIQUE INDEX "AdminRoleAssignment_active_unique"
  ON "AdminRoleAssignment" ("userId", "roleId")
  WHERE "revokedAt" IS NULL;
