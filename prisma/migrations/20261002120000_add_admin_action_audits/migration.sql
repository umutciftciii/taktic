-- ADMIN-ACTION-AUDIT-001 — admin action audit.
--
-- Additive only: two enums, four new append-only tables and one nullable
-- column. No existing row is touched and nothing is backfilled — a status
-- change, a settings save or an invite withdrawal that happened before this
-- migration was not recorded, and inventing its actor or its old value would
-- be worse than saying "Bilinmiyor".

-- CreateEnum
CREATE TYPE "CatalogAuditEntity" AS ENUM ('CATEGORY', 'CREDIT_PACKAGE', 'SHOWCASE_PACKAGE');

-- CreateEnum
CREATE TYPE "CatalogAuditAction" AS ENUM ('CREATED', 'UPDATED', 'STATUS_CHANGED');

-- AlterTable
ALTER TABLE "ProviderInviteToken" ADD COLUMN     "revokedById" TEXT;

-- CreateTable
CREATE TABLE "AccountStatusChange" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userRole" "UserRole" NOT NULL,
    "fromActive" BOOLEAN NOT NULL,
    "toActive" BOOLEAN NOT NULL,
    "reason" TEXT,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountStatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderStatusChange" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "fromStatus" "ProviderStatus" NOT NULL,
    "toStatus" "ProviderStatus" NOT NULL,
    "moderationNote" TEXT,
    "rejectionReason" TEXT,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderStatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanySettingsChange" (
    "id" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanySettingsChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogAuditLog" (
    "id" TEXT NOT NULL,
    "entityType" "CatalogAuditEntity" NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" "CatalogAuditAction" NOT NULL,
    "changes" JSONB NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountStatusChange_userId_createdAt_id_idx" ON "AccountStatusChange"("userId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "AccountStatusChange_actorId_idx" ON "AccountStatusChange"("actorId");

-- CreateIndex
CREATE INDEX "ProviderStatusChange_providerId_createdAt_id_idx" ON "ProviderStatusChange"("providerId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "ProviderStatusChange_actorId_idx" ON "ProviderStatusChange"("actorId");

-- CreateIndex
CREATE INDEX "CompanySettingsChange_createdAt_id_idx" ON "CompanySettingsChange"("createdAt", "id");

-- CreateIndex
CREATE INDEX "CompanySettingsChange_actorId_idx" ON "CompanySettingsChange"("actorId");

-- CreateIndex
CREATE INDEX "CatalogAuditLog_entityType_entityId_createdAt_id_idx" ON "CatalogAuditLog"("entityType", "entityId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "CatalogAuditLog_actorId_idx" ON "CatalogAuditLog"("actorId");

-- CreateIndex
CREATE INDEX "ProviderInviteToken_revokedById_idx" ON "ProviderInviteToken"("revokedById");

-- AddForeignKey
ALTER TABLE "ProviderInviteToken" ADD CONSTRAINT "ProviderInviteToken_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountStatusChange" ADD CONSTRAINT "AccountStatusChange_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountStatusChange" ADD CONSTRAINT "AccountStatusChange_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderStatusChange" ADD CONSTRAINT "ProviderStatusChange_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderStatusChange" ADD CONSTRAINT "ProviderStatusChange_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanySettingsChange" ADD CONSTRAINT "CompanySettingsChange_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogAuditLog" ADD CONSTRAINT "CatalogAuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- CHECK: a status row records a change, never a no-op.
ALTER TABLE "AccountStatusChange" ADD CONSTRAINT "AccountStatusChange_is_a_change" CHECK (
  "fromActive" <> "toActive"
);

ALTER TABLE "ProviderStatusChange" ADD CONSTRAINT "ProviderStatusChange_is_a_change" CHECK (
  "fromStatus" <> "toStatus"
);

-- CHECK: a field diff is a non-empty array. A save that changed nothing
-- writes no row; CREATED is the one action that may list every field.
ALTER TABLE "CompanySettingsChange" ADD CONSTRAINT "CompanySettingsChange_changes_shape" CHECK (
  jsonb_typeof("changes") = 'array' AND jsonb_array_length("changes") >= 1
);

ALTER TABLE "CatalogAuditLog" ADD CONSTRAINT "CatalogAuditLog_changes_shape" CHECK (
  jsonb_typeof("changes") = 'array' AND jsonb_array_length("changes") >= 1
);

-- CHECK: only a withdrawn invite names who withdrew it.
ALTER TABLE "ProviderInviteToken" ADD CONSTRAINT "ProviderInviteToken_revoker_requires_revoked" CHECK (
  "revokedById" IS NULL OR "revokedAt" IS NOT NULL
);

-- Trigger: append-only tables. Reuses the generic function CMP-006 PR-C
-- created (it names the table from TG_TABLE_NAME). TRUNCATE, which only test
-- harnesses issue, does not fire row triggers.
CREATE TRIGGER "AccountStatusChange_append_only"
  BEFORE UPDATE OR DELETE ON "AccountStatusChange"
  FOR EACH ROW EXECUTE FUNCTION "cmp006_append_only_fn"();

CREATE TRIGGER "ProviderStatusChange_append_only"
  BEFORE UPDATE OR DELETE ON "ProviderStatusChange"
  FOR EACH ROW EXECUTE FUNCTION "cmp006_append_only_fn"();

CREATE TRIGGER "CompanySettingsChange_append_only"
  BEFORE UPDATE OR DELETE ON "CompanySettingsChange"
  FOR EACH ROW EXECUTE FUNCTION "cmp006_append_only_fn"();

CREATE TRIGGER "CatalogAuditLog_append_only"
  BEFORE UPDATE OR DELETE ON "CatalogAuditLog"
  FOR EACH ROW EXECUTE FUNCTION "cmp006_append_only_fn"();
