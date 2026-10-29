-- PROVIDER-STATUS-001: why an operator suspended a provider.
--
-- Additive and nullable. No existing row is touched: a profile suspended before
-- this column existed keeps NULL, which reads as "no reason was recorded" —
-- exactly what happened — and nothing is backfilled.
--
-- The reason is operator-only. It is read by the authorized admin screens and
-- the status history; no provider- or customer-facing projection carries it.
ALTER TABLE "ProviderProfile" ADD COLUMN "suspensionReason" TEXT;

ALTER TABLE "ProviderStatusChange" ADD COLUMN "suspensionReason" TEXT;

-- Every suspension recorded from now on carries its reason. NOT VALID: the
-- history rows written before this migration are left as they are (they have
-- none and never will), and PostgreSQL checks only rows inserted from here on.
-- The table is append-only, so no old row is ever re-checked by an UPDATE.
ALTER TABLE "ProviderStatusChange"
  ADD CONSTRAINT "ProviderStatusChange_suspension_has_reason" CHECK (
    "toStatus" <> 'SUSPENDED'
    OR ("suspensionReason" IS NOT NULL AND btrim("suspensionReason") <> '')
  ) NOT VALID;
