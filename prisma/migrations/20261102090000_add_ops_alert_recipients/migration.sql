-- OBS-ALERT-002: operations-alert e-mail recipients managed from the admin
-- panel, encrypted at rest, with every e-mail delivery bound to an immutable
-- recipient.
--
-- Adds three tables (OpsAlertRecipient, OpsAlertRoutingSettings,
-- OpsAlertRecipientAuditLog), three enums, six AdminPermission values and two
-- nullable columns on OpsAlertDelivery (recipientId, noticeSnapshot). Nothing
-- is backfilled and nothing changes behaviour: the routing row starts as
-- ENV_LEGACY, which is OBS-ALERT-001 exactly, and every existing delivery row
-- has recipientId NULL.
--
-- The one existing object that changes is the unique index on
-- (alertId, kind, sequence, channel). It becomes two partial indexes — the
-- same columns among legacy rows (recipientId IS NULL), and
-- (alertId, kind, sequence, recipientId) among managed ones — so a notice is
-- still created once per channel in legacy mode and once per recipient in
-- managed mode. The new indexes are created before the old one is dropped,
-- so there is no moment without uniqueness. Prisma cannot express partial
-- indexes, so they exist only here and in the database.
--
-- Rollback: scripts/ops/obs-alert-002-rollback.sql (to be added with the
-- rollback tooling); until then it is dropping the three tables, three enums
-- and two columns, and recreating the old unique index. The AdminPermission
-- values stay, as PostgreSQL cannot drop an enum value.

-- CreateEnum
CREATE TYPE "OpsAlertRecipientStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DELETED');

-- CreateEnum
CREATE TYPE "OpsAlertEmailRouting" AS ENUM ('ENV_LEGACY', 'MANAGED');

-- CreateEnum
CREATE TYPE "OpsAlertRecipientAuditAction" AS ENUM ('CREATED', 'IMPORTED_FROM_ENV', 'LABEL_CHANGED', 'PREFERENCES_CHANGED', 'PAUSED', 'RESUMED', 'DELETED', 'ADDRESS_REPLACED', 'REVEALED', 'TEST_SENT', 'ROUTING_CUTOVER', 'ROUTING_REVERTED', 'REWRAPPED', 'REHASHED');

-- AlterEnum
-- The new values are not used in this migration (ADD VALUE cannot be, inside
-- the transaction that adds it); they are first granted by application code.
ALTER TYPE "AdminPermission" ADD VALUE IF NOT EXISTS 'OPS_ALERT_RECIPIENTS_READ';
ALTER TYPE "AdminPermission" ADD VALUE IF NOT EXISTS 'OPS_ALERT_RECIPIENTS_WRITE';
ALTER TYPE "AdminPermission" ADD VALUE IF NOT EXISTS 'OPS_ALERT_RECIPIENTS_DELETE';
ALTER TYPE "AdminPermission" ADD VALUE IF NOT EXISTS 'OPS_ALERT_RECIPIENTS_REVEAL';
ALTER TYPE "AdminPermission" ADD VALUE IF NOT EXISTS 'OPS_ALERT_RECIPIENTS_TEST';
ALTER TYPE "AdminPermission" ADD VALUE IF NOT EXISTS 'OPS_ALERT_ROUTING_MANAGE';

-- AlterTable
ALTER TABLE "OpsAlertDelivery" ADD COLUMN     "noticeSnapshot" JSONB,
ADD COLUMN     "recipientId" TEXT;

-- CreateTable
CREATE TABLE "OpsAlertRecipient" (
    "id" TEXT NOT NULL,
    "channel" "OpsAlertChannel" NOT NULL DEFAULT 'EMAIL',
    "label" TEXT NOT NULL,
    "addressCiphertext" BYTEA,
    "addressNonce" BYTEA,
    "addressTag" BYTEA,
    "addressKeyId" TEXT,
    "addressHmac" TEXT,
    "addressHmacVersion" INTEGER,
    "maskedAddress" TEXT NOT NULL,
    "notifyWarning" BOOLEAN NOT NULL,
    "notifyCritical" BOOLEAN NOT NULL,
    "notifyRecovery" BOOLEAN NOT NULL,
    "status" "OpsAlertRecipientStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsAlertRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsAlertRoutingSettings" (
    "id" TEXT NOT NULL,
    "emailRouting" "OpsAlertEmailRouting" NOT NULL DEFAULT 'ENV_LEGACY',
    "changedAt" TIMESTAMP(3),
    "changedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsAlertRoutingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsAlertRecipientAuditLog" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT,
    "actorId" TEXT NOT NULL,
    "action" "OpsAlertRecipientAuditAction" NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpsAlertRecipientAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpsAlertRecipient_status_createdAt_idx" ON "OpsAlertRecipient"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OpsAlertRecipientAuditLog_recipientId_createdAt_idx" ON "OpsAlertRecipientAuditLog"("recipientId", "createdAt");

-- CreateIndex
CREATE INDEX "OpsAlertRecipientAuditLog_createdAt_idx" ON "OpsAlertRecipientAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "OpsAlertDelivery_recipientId_createdAt_idx" ON "OpsAlertDelivery"("recipientId", "createdAt");

-- AddForeignKey
ALTER TABLE "OpsAlertDelivery" ADD CONSTRAINT "OpsAlertDelivery_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "OpsAlertRecipient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsAlertRecipient" ADD CONSTRAINT "OpsAlertRecipient_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsAlertRecipient" ADD CONSTRAINT "OpsAlertRecipient_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsAlertRecipient" ADD CONSTRAINT "OpsAlertRecipient_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsAlertRoutingSettings" ADD CONSTRAINT "OpsAlertRoutingSettings_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsAlertRecipientAuditLog" ADD CONSTRAINT "OpsAlertRecipientAuditLog_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "OpsAlertRecipient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsAlertRecipientAuditLog" ADD CONSTRAINT "OpsAlertRecipientAuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One live delivery row per notice. Legacy rows keep the old per-channel
-- uniqueness; managed rows are unique per recipient. `ON CONFLICT DO NOTHING`
-- and createMany({ skipDuplicates }) have no conflict target, so they treat a
-- violation of either index as a duplicate.
CREATE UNIQUE INDEX "OpsAlertDelivery_legacy_notice_key"
  ON "OpsAlertDelivery"("alertId", "kind", "sequence", "channel") WHERE "recipientId" IS NULL;

CREATE UNIQUE INDEX "OpsAlertDelivery_recipient_notice_key"
  ON "OpsAlertDelivery"("alertId", "kind", "sequence", "recipientId") WHERE "recipientId" IS NOT NULL;

DROP INDEX "OpsAlertDelivery_alertId_kind_sequence_channel_key";

-- Only e-mail rows are bound to a recipient; Telegram is not managed here.
ALTER TABLE "OpsAlertDelivery"
  ADD CONSTRAINT "OpsAlertDelivery_recipient_channel_check" CHECK ("recipientId" IS NULL OR "channel" = 'EMAIL');

-- The same address cannot be a live recipient twice. A shredded recipient has
-- no HMAC, so a deleted address can be added again.
CREATE UNIQUE INDEX "OpsAlertRecipient_addressHmac_live_key"
  ON "OpsAlertRecipient"("addressHmac") WHERE "status" <> 'DELETED';

-- Crypto-shred: a DELETED recipient holds none of the encrypted address, its
-- key id or its HMAC; every other recipient holds all of them.
ALTER TABLE "OpsAlertRecipient"
  ADD CONSTRAINT "OpsAlertRecipient_shred_check" CHECK (
    (
      "status" = 'DELETED'
      AND "addressCiphertext" IS NULL AND "addressNonce" IS NULL AND "addressTag" IS NULL
      AND "addressKeyId" IS NULL AND "addressHmac" IS NULL AND "addressHmacVersion" IS NULL
    )
    OR (
      "status" <> 'DELETED'
      AND "addressCiphertext" IS NOT NULL AND "addressNonce" IS NOT NULL AND "addressTag" IS NOT NULL
      AND "addressKeyId" IS NOT NULL AND "addressHmac" IS NOT NULL AND "addressHmacVersion" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "OpsAlertRecipient_label_check" CHECK (char_length("label") BETWEEN 1 AND 80);

-- At most 10 live recipients, enforced where racing writers meet. The lock
-- serialises inserts and revivals so two sessions cannot both take the last
-- slot; the count is read after the lock, with a fresh snapshot. The key is
-- OPS_ALERT_RECIPIENT_LOCK_KEY and the limit OPS_ALERT_RECIPIENT_LIMIT
-- (ops-alert-recipient.constants.ts); keep them in step.
CREATE FUNCTION "ops_alert_recipient_limit_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'DELETED' AND (TG_OP = 'INSERT' OR OLD."status" = 'DELETED') THEN
    PERFORM pg_advisory_xact_lock(190455298);
    IF (SELECT count(*) FROM "OpsAlertRecipient" WHERE "status" <> 'DELETED') >= 10 THEN
      -- The name is in the message as well: client libraries that drop the
      -- constraint field (Prisma) still let the caller tell this refusal apart.
      RAISE EXCEPTION 'ops_alert_recipient_limit: at most 10 live operations alert recipients'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ops_alert_recipient_limit';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "OpsAlertRecipient_limit"
  BEFORE INSERT OR UPDATE OF "status" ON "OpsAlertRecipient"
  FOR EACH ROW EXECUTE FUNCTION "ops_alert_recipient_limit_fn"();

-- Audit rows are never changed or removed. cmp006_append_only_fn is the shared
-- append-only trigger function (20260923180000).
CREATE TRIGGER "OpsAlertRecipientAuditLog_append_only"
  BEFORE UPDATE OR DELETE ON "OpsAlertRecipientAuditLog"
  FOR EACH ROW EXECUTE FUNCTION "cmp006_append_only_fn"();

-- One routing row, by name, starting in OBS-ALERT-001 mode.
ALTER TABLE "OpsAlertRoutingSettings"
  ADD CONSTRAINT "OpsAlertRoutingSettings_singleton_check" CHECK ("id" = 'ops-alert-routing');

INSERT INTO "OpsAlertRoutingSettings" ("id", "emailRouting", "updatedAt")
  VALUES ('ops-alert-routing', 'ENV_LEGACY', CURRENT_TIMESTAMP);
