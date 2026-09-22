-- CMP-006 PR-A — Migration I: purchase-terms acceptance evidence.
--
-- Additive only. No DML: every existing PackagePurchase keeps
-- "termsAcceptanceRequired" = false and "purchaseTermsAcceptanceId" = NULL,
-- which is the honest answer — nobody was shown a purchase-terms text before
-- this migration, so there is nothing to backfill.
--
-- What the database guarantees on its own (the service is the second fence):
--   1. An enforced purchase cannot exist without its acceptance, and an
--      unenforced one cannot carry one (CHECK, biconditional).
--   2. An acceptance belongs to exactly one purchase and that purchase points
--      back at it (composite FK, deferred to commit so both rows are written
--      in one transaction, acceptance first).
--   3. Neither the requirement nor the link can change after the insert
--      (trigger on PackagePurchase).
--   4. An acceptance row is append-only and its "acceptedAt" is the
--      transaction clock, never a caller's value (trigger).
--   5. The digest is the SHA-256 of the stored snapshot, the snapshot names
--      its own version and carries all three documents (CHECKs).
-- No rule here is time-thresholded: enforcement is a per-row fact written by
-- the checkout transaction while the release gate is open, so a forged
-- "createdAt" on either table changes nothing.

-- CreateEnum
CREATE TYPE "SourceChannel" AS ENUM ('WEB', 'MOBILE', 'UNKNOWN');

-- AlterTable
ALTER TABLE "PackagePurchase" ADD COLUMN     "purchaseTermsAcceptanceId" TEXT,
ADD COLUMN     "termsAcceptanceRequired" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PurchaseTermsAcceptance" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentKey" TEXT NOT NULL,
    "documentVersion" TEXT NOT NULL,
    "documentSha256" TEXT NOT NULL,
    "documentTextSnapshot" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clientIp" TEXT,
    "userAgent" TEXT,
    "sourceChannel" "SourceChannel" NOT NULL,

    CONSTRAINT "PurchaseTermsAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseTermsAcceptance_purchaseId_key" ON "PurchaseTermsAcceptance"("purchaseId");

-- CreateIndex
CREATE INDEX "PurchaseTermsAcceptance_userId_idx" ON "PurchaseTermsAcceptance"("userId");

-- CreateIndex
CREATE INDEX "PurchaseTermsAcceptance_documentKey_documentVersion_idx" ON "PurchaseTermsAcceptance"("documentKey", "documentVersion");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseTermsAcceptance_purchaseId_id_key" ON "PurchaseTermsAcceptance"("purchaseId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PackagePurchase_purchaseTermsAcceptanceId_key" ON "PackagePurchase"("purchaseTermsAcceptanceId");

-- CreateIndex
CREATE UNIQUE INDEX "PackagePurchase_id_purchaseTermsAcceptanceId_key" ON "PackagePurchase"("id", "purchaseTermsAcceptanceId");

-- AddForeignKey
ALTER TABLE "PackagePurchase" ADD CONSTRAINT "PackagePurchase_purchaseTermsAcceptanceId_fkey" FOREIGN KEY ("purchaseTermsAcceptanceId") REFERENCES "PurchaseTermsAcceptance"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
-- DEFERRABLE INITIALLY DEFERRED (hand-written; Prisma cannot express it and
-- does not introspect it, so `migrate diff` stays empty): the acceptance is
-- inserted before the purchase it names, inside one transaction, and the pair
-- is checked at COMMIT. An acceptance whose purchase never arrives — or whose
-- purchase names a different acceptance — fails the commit, so "both or
-- neither" is the database's rule, not the service's.
ALTER TABLE "PurchaseTermsAcceptance" ADD CONSTRAINT "PurchaseTermsAcceptance_purchaseId_id_fkey" FOREIGN KEY ("purchaseId", "id") REFERENCES "PackagePurchase"("id", "purchaseTermsAcceptanceId") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "PurchaseTermsAcceptance" ADD CONSTRAINT "PurchaseTermsAcceptance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK: requirement ⇔ evidence. TRUE with no acceptance is an enforced
-- purchase without proof; FALSE with one would be evidence nobody asked for.
ALTER TABLE "PackagePurchase" ADD CONSTRAINT "PackagePurchase_terms_acceptance_matches_requirement"
  CHECK (("purchaseTermsAcceptanceId" IS NOT NULL) = "termsAcceptanceRequired");

-- CHECK: the purchase-terms set covers credit packages only. Vitrin purchases
-- have their own acceptance columns and CHECK.
ALTER TABLE "PackagePurchase" ADD CONSTRAINT "PackagePurchase_terms_acceptance_offer_only"
  CHECK (NOT "termsAcceptanceRequired" OR "kind" = 'OFFER_PACKAGE');

ALTER TABLE "PurchaseTermsAcceptance" ADD CONSTRAINT "PurchaseTermsAcceptance_document_key"
  CHECK ("documentKey" = 'PACKAGE_PURCHASE_TERMS');

ALTER TABLE "PurchaseTermsAcceptance" ADD CONSTRAINT "PurchaseTermsAcceptance_document_version"
  CHECK ("documentVersion" ~ '^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$');

ALTER TABLE "PurchaseTermsAcceptance" ADD CONSTRAINT "PurchaseTermsAcceptance_sha256_format"
  CHECK ("documentSha256" ~ '^[0-9a-f]{64}$');

-- The digest is recomputed by the database from the stored text. A row whose
-- digest was computed over anything else — a different text, a different
-- encoding, a trimmed copy — is refused.
ALTER TABLE "PurchaseTermsAcceptance" ADD CONSTRAINT "PurchaseTermsAcceptance_sha256_matches_snapshot"
  CHECK ("documentSha256" = encode(sha256(convert_to("documentTextSnapshot", 'UTF8')), 'hex'));

-- The snapshot is the combined full text (see purchase-terms.snapshot.ts for
-- the exact layout): its header names the key and this row's version, and it
-- carries the three document sections in order. A link, a summary or a text
-- rendered for another version cannot pass.
ALTER TABLE "PurchaseTermsAcceptance" ADD CONSTRAINT "PurchaseTermsAcceptance_snapshot_shape"
  CHECK (
    char_length("documentTextSnapshot") >= 600
    AND starts_with("documentTextSnapshot", E'TAKTIC PACKAGE_PURCHASE_TERMS\nversion: ' || "documentVersion" || E'\n')
    AND strpos("documentTextSnapshot", E'\n=== MESAFELI_SATIS_SOZLESMESI: ') > 0
    AND strpos("documentTextSnapshot", E'\n=== ON_BILGILENDIRME_FORMU: ')
        > strpos("documentTextSnapshot", E'\n=== MESAFELI_SATIS_SOZLESMESI: ')
    AND strpos("documentTextSnapshot", E'\n=== PAKET_IADE_POLITIKASI: ')
        > strpos("documentTextSnapshot", E'\n=== ON_BILGILENDIRME_FORMU: ')
  );

ALTER TABLE "PurchaseTermsAcceptance" ADD CONSTRAINT "PurchaseTermsAcceptance_client_ip_length"
  CHECK ("clientIp" IS NULL OR char_length("clientIp") BETWEEN 1 AND 64);

ALTER TABLE "PurchaseTermsAcceptance" ADD CONSTRAINT "PurchaseTermsAcceptance_user_agent_length"
  CHECK ("userAgent" IS NULL OR char_length("userAgent") BETWEEN 1 AND 500);

-- Trigger: the acceptance row is append-only, and its moment is the
-- transaction's. INSERT overwrites "acceptedAt" with now() whatever the
-- statement carried; UPDATE and DELETE are refused outright. (TRUNCATE, which
-- only the test harnesses issue, does not fire row triggers.)
CREATE FUNCTION "PurchaseTermsAcceptance_append_only_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."acceptedAt" := now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PurchaseTermsAcceptance is append-only (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "PurchaseTermsAcceptance_append_only"
  BEFORE INSERT OR UPDATE OR DELETE ON "PurchaseTermsAcceptance"
  FOR EACH ROW EXECUTE FUNCTION "PurchaseTermsAcceptance_append_only_fn"();

-- Trigger: once a purchase is inserted, whether it was enforced and which
-- acceptance proves it are fixed. Every other column keeps its existing
-- writers (settlement, webhook flags, admin status).
CREATE FUNCTION "PackagePurchase_terms_evidence_immutable_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."termsAcceptanceRequired" IS DISTINCT FROM OLD."termsAcceptanceRequired"
     OR NEW."purchaseTermsAcceptanceId" IS DISTINCT FROM OLD."purchaseTermsAcceptanceId" THEN
    RAISE EXCEPTION 'PackagePurchase terms evidence is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PackagePurchase_terms_evidence_immutable"
  BEFORE UPDATE ON "PackagePurchase"
  FOR EACH ROW EXECUTE FUNCTION "PackagePurchase_terms_evidence_immutable_fn"();
