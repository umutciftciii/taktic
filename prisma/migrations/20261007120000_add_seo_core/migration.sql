-- SEO-004 PR A: the SEO core.
--
-- Additive only. No existing row is rewritten here (the one controlled
-- backfill, the illustration key, is its own migration after this one):
-- - Three permissions. Nothing holds them the moment this runs; a SUPER_ADMIN
--   holds them implicitly, as it holds every permission. No role is granted.
-- - Six nullable ServiceCategory columns with no default: every existing
--   category reads exactly as before, and none becomes indexable by this
--   migration (the editorial blocks are NULL until an operator writes them).
-- - Three new tables, empty. No redirect is invented for a slug that changed
--   before this migration (SEO-004 locked decision 12).
-- CreateEnum
CREATE TYPE "SeoRedirectType" AS ENUM ('PERMANENT', 'TEMPORARY');

-- CreateEnum
CREATE TYPE "SeoRedirectOrigin" AS ENUM ('MANUAL', 'SLUG_CHANGE', 'NOT_FOUND_SUGGESTION');

-- CreateEnum
CREATE TYPE "SeoNotFoundRouteFamily" AS ENUM ('CATEGORY', 'PROVIDER', 'SHOWCASE_CARD');

-- CreateEnum
CREATE TYPE "SeoNotFoundStatus" AS ENUM ('OPEN', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SeoAuditEntity" AS ENUM ('REDIRECT', 'NOT_FOUND_PATH');

-- CreateEnum
CREATE TYPE "SeoAuditAction" AS ENUM ('REDIRECT_CREATED', 'REDIRECT_UPDATED', 'REDIRECT_DEACTIVATED', 'REDIRECT_RETARGETED', 'REDIRECT_RECLAIMED', 'SUGGESTION_APPROVED', 'SUGGESTION_REJECTED');

ALTER TYPE "AdminPermission" ADD VALUE 'SEO_READ';
ALTER TYPE "AdminPermission" ADD VALUE 'SEO_CONTENT_WRITE';
ALTER TYPE "AdminPermission" ADD VALUE 'SEO_REDIRECTS_WRITE';

-- AlterTable
ALTER TABLE "ServiceCategory" ADD COLUMN     "editorialDecisionGuide" TEXT,
ADD COLUMN     "editorialFaq" JSONB,
ADD COLUMN     "editorialPriceFactors" TEXT,
ADD COLUMN     "illustrationKey" TEXT,
ADD COLUMN     "seoDescription" TEXT,
ADD COLUMN     "seoTitle" TEXT;

-- CreateTable
CREATE TABLE "SeoRedirect" (
    "id" TEXT NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "targetPath" TEXT NOT NULL,
    "type" "SeoRedirectType" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "origin" "SeoRedirectOrigin" NOT NULL,
    "reason" TEXT,
    "categoryId" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "deactivatedById" TEXT,
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoRedirect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoNotFoundPath" (
    "id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "routeFamily" "SeoNotFoundRouteFamily" NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "occurrenceCount" INTEGER NOT NULL,
    "seenDays" INTEGER NOT NULL,
    "status" "SeoNotFoundStatus" NOT NULL DEFAULT 'OPEN',
    "candidateTargetPath" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "redirectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoNotFoundPath_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoAuditLog" (
    "id" TEXT NOT NULL,
    "entityType" "SeoAuditEntity" NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" "SeoAuditAction" NOT NULL,
    "changes" JSONB NOT NULL,
    "reason" TEXT,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeoAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SeoRedirect_categoryId_idx" ON "SeoRedirect"("categoryId");

-- CreateIndex
CREATE INDEX "SeoRedirect_createdById_idx" ON "SeoRedirect"("createdById");

-- CreateIndex
CREATE INDEX "SeoRedirect_updatedById_idx" ON "SeoRedirect"("updatedById");

-- CreateIndex
CREATE INDEX "SeoRedirect_deactivatedById_idx" ON "SeoRedirect"("deactivatedById");

-- CreateIndex
CREATE UNIQUE INDEX "SeoNotFoundPath_path_key" ON "SeoNotFoundPath"("path");

-- CreateIndex
CREATE INDEX "SeoNotFoundPath_status_occurrenceCount_idx" ON "SeoNotFoundPath"("status", "occurrenceCount");

-- CreateIndex
CREATE INDEX "SeoNotFoundPath_lastSeenAt_idx" ON "SeoNotFoundPath"("lastSeenAt");

-- CreateIndex
CREATE INDEX "SeoNotFoundPath_decidedById_idx" ON "SeoNotFoundPath"("decidedById");

-- CreateIndex
CREATE INDEX "SeoNotFoundPath_redirectId_idx" ON "SeoNotFoundPath"("redirectId");

-- CreateIndex
CREATE INDEX "SeoAuditLog_entityType_entityId_createdAt_id_idx" ON "SeoAuditLog"("entityType", "entityId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "SeoAuditLog_actorId_idx" ON "SeoAuditLog"("actorId");

-- CreateIndex
CREATE INDEX "SeoAuditLog_createdAt_id_idx" ON "SeoAuditLog"("createdAt", "id");

-- AddForeignKey
ALTER TABLE "SeoRedirect" ADD CONSTRAINT "SeoRedirect_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeoRedirect" ADD CONSTRAINT "SeoRedirect_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeoRedirect" ADD CONSTRAINT "SeoRedirect_deactivatedById_fkey" FOREIGN KEY ("deactivatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeoNotFoundPath" ADD CONSTRAINT "SeoNotFoundPath_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeoNotFoundPath" ADD CONSTRAINT "SeoNotFoundPath_redirectId_fkey" FOREIGN KEY ("redirectId") REFERENCES "SeoRedirect"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeoAuditLog" ADD CONSTRAINT "SeoAuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- What the database holds on its own, whatever writes the row.
-- ---------------------------------------------------------------------------

-- Category SEO content: the limits the API validates, restated so a row that
-- slipped past the API is still refused. NULL is "not written"; a blank
-- string is not a value.
ALTER TABLE "ServiceCategory"
  ADD CONSTRAINT "ServiceCategory_seo_title_shape" CHECK (
    "seoTitle" IS NULL OR (char_length("seoTitle") <= 70 AND btrim("seoTitle") <> '')
  ),
  ADD CONSTRAINT "ServiceCategory_seo_description_shape" CHECK (
    "seoDescription" IS NULL OR (char_length("seoDescription") <= 160 AND btrim("seoDescription") <> '')
  ),
  ADD CONSTRAINT "ServiceCategory_editorial_decision_guide_shape" CHECK (
    "editorialDecisionGuide" IS NULL OR (char_length("editorialDecisionGuide") <= 6000 AND btrim("editorialDecisionGuide") <> '')
  ),
  ADD CONSTRAINT "ServiceCategory_editorial_price_factors_shape" CHECK (
    "editorialPriceFactors" IS NULL OR (char_length("editorialPriceFactors") <= 6000 AND btrim("editorialPriceFactors") <> '')
  ),
  ADD CONSTRAINT "ServiceCategory_editorial_faq_shape" CHECK (
    "editorialFaq" IS NULL OR (jsonb_typeof("editorialFaq") = 'array' AND jsonb_array_length("editorialFaq") BETWEEN 1 AND 20)
  ),
  ADD CONSTRAINT "ServiceCategory_illustration_key_shape" CHECK (
    "illustrationKey" IS NULL OR "illustrationKey" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  );

-- A redirect is an address pair in canonical form: rooted, no query, no
-- fragment, no backslash, at most 200 characters, never the root, never to
-- itself.
ALTER TABLE "SeoRedirect"
  ADD CONSTRAINT "SeoRedirect_source_shape" CHECK (
    "sourcePath" ~ '^/[^?#\\]+$' AND char_length("sourcePath") <= 200 AND "sourcePath" !~ '/$' AND "sourcePath" !~ '//'
  ),
  ADD CONSTRAINT "SeoRedirect_target_shape" CHECK (
    "targetPath" ~ '^/([^?#\\]*)$' AND char_length("targetPath") <= 200 AND ("targetPath" = '/' OR "targetPath" !~ '/$') AND "targetPath" !~ '//'
  ),
  ADD CONSTRAINT "SeoRedirect_not_to_itself" CHECK ("sourcePath" <> "targetPath"),
  -- Active exactly when it was never deactivated; a deactivation names its operator.
  ADD CONSTRAINT "SeoRedirect_deactivation_bookkeeping" CHECK (
    ("active" AND "deactivatedAt" IS NULL AND "deactivatedById" IS NULL)
    OR (NOT "active" AND "deactivatedAt" IS NOT NULL AND "deactivatedById" IS NOT NULL)
  ),
  -- A slug change is permanent and says which category it was written for.
  ADD CONSTRAINT "SeoRedirect_slug_change_shape" CHECK (
    "origin" <> 'SLUG_CHANGE' OR ("type" = 'PERMANENT' AND "categoryId" IS NOT NULL)
  ),
  ADD CONSTRAINT "SeoRedirect_reason_shape" CHECK (
    "reason" IS NULL OR (char_length("reason") <= 500 AND btrim("reason") <> '')
  );

-- One active redirect per source. Inactive rows are history and may repeat.
CREATE UNIQUE INDEX "SeoRedirect_active_source_key" ON "SeoRedirect" ("sourcePath") WHERE "active";
-- "Which active redirects lead here" — the chain check and the retarget.
CREATE INDEX "SeoRedirect_active_target_idx" ON "SeoRedirect" ("targetPath") WHERE "active";

-- No hard delete: "Kaldır" deactivates. TRUNCATE (the test harness) is a
-- statement-level operation and does not fire this row trigger.
CREATE FUNCTION "SeoRedirect_refuse_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SeoRedirect rows are never deleted; deactivate instead' USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "SeoRedirect_no_delete" BEFORE DELETE ON "SeoRedirect"
  FOR EACH ROW EXECUTE FUNCTION "SeoRedirect_refuse_delete"();

-- A 404 suggestion: the counters are counts, a decision is complete.
ALTER TABLE "SeoNotFoundPath"
  ADD CONSTRAINT "SeoNotFoundPath_path_shape" CHECK (
    "path" ~ '^/[^?#\\]+$' AND char_length("path") <= 200
  ),
  ADD CONSTRAINT "SeoNotFoundPath_counts" CHECK (
    "occurrenceCount" >= 1 AND "seenDays" >= 1 AND "seenDays" <= "occurrenceCount" AND "firstSeenAt" <= "lastSeenAt"
  ),
  ADD CONSTRAINT "SeoNotFoundPath_decision_bookkeeping" CHECK (
    ("status" = 'OPEN' AND "decidedById" IS NULL AND "decidedAt" IS NULL AND "redirectId" IS NULL)
    OR ("status" = 'APPROVED' AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND "redirectId" IS NOT NULL)
    OR ("status" = 'REJECTED' AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND "redirectId" IS NULL)
  );

ALTER TABLE "SeoAuditLog"
  ADD CONSTRAINT "SeoAuditLog_changes_shape" CHECK (jsonb_typeof("changes") = 'array'),
  ADD CONSTRAINT "SeoAuditLog_reason_shape" CHECK ("reason" IS NULL OR char_length("reason") <= 500);
