-- CMP-006 PR-D — Migration L: campaign channel targeting.
--
-- Additive only. No DML, no backfill statement, no DROP, no ALTER COLUMN.
-- Every existing row takes the column default, and each default is the honest
-- value for what that row already was:
--
--   CampaignVersion.channel = ALL      no campaign ever discriminated by
--                                       channel; ALL is "no channel condition"
--   CampaignTriggerEvent.sourceChannel = UNKNOWN
--   PackagePurchase.sourceChannel      = UNKNOWN   nobody recorded a channel
--   ProviderProfile.applicationSourceChannel = UNKNOWN
--
-- ALL matches UNKNOWN, so no existing (version, event) pair is judged
-- differently after this migration than before it.
--
-- What the database guarantees on its own: the four channel columns are
-- written on INSERT and never changed afterwards. One trigger function, bound
-- per table with `BEFORE UPDATE OF <column>` so it only runs when an UPDATE
-- names the column, refuses any UPDATE that would change the value. A version
-- is an immutable snapshot, and an event's, a purchase's or an application's
-- channel is a fact about how it happened.
--
-- The channel is deliberately not part of `CampaignTriggerEvent.triggerEventKey`
-- (unchanged): a second derivation of the same event's channel can therefore
-- neither mint a second event nor a second redemption.
--
-- The new outcome value CHANNEL_MISMATCH is added but not used here (a value
-- added by ALTER TYPE cannot be used in the same transaction).

-- CreateEnum
CREATE TYPE "CampaignChannel" AS ENUM ('WEB', 'MOBILE', 'ALL');

-- AlterEnum
ALTER TYPE "CampaignEvaluationOutcome" ADD VALUE 'CHANNEL_MISMATCH';

-- AlterTable
ALTER TABLE "CampaignTriggerEvent" ADD COLUMN     "sourceChannel" "SourceChannel" NOT NULL DEFAULT 'UNKNOWN';

-- AlterTable
ALTER TABLE "CampaignVersion" ADD COLUMN     "channel" "CampaignChannel" NOT NULL DEFAULT 'ALL';

-- AlterTable
ALTER TABLE "PackagePurchase" ADD COLUMN     "sourceChannel" "SourceChannel" NOT NULL DEFAULT 'UNKNOWN';

-- AlterTable
ALTER TABLE "ProviderProfile" ADD COLUMN     "applicationSourceChannel" "SourceChannel" NOT NULL DEFAULT 'UNKNOWN';

-- Immutability: the column named by the trigger's argument may not change.
CREATE FUNCTION "refuse_channel_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) -> TG_ARGV[0]) IS DISTINCT FROM (to_jsonb(OLD) -> TG_ARGV[0]) THEN
    RAISE EXCEPTION '%.% is written on insert and never changed', TG_TABLE_NAME, TG_ARGV[0]
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CampaignVersion_channel_immutable"
  BEFORE UPDATE OF "channel" ON "CampaignVersion"
  FOR EACH ROW EXECUTE FUNCTION "refuse_channel_change"('channel');

CREATE TRIGGER "CampaignTriggerEvent_source_channel_immutable"
  BEFORE UPDATE OF "sourceChannel" ON "CampaignTriggerEvent"
  FOR EACH ROW EXECUTE FUNCTION "refuse_channel_change"('sourceChannel');

CREATE TRIGGER "PackagePurchase_source_channel_immutable"
  BEFORE UPDATE OF "sourceChannel" ON "PackagePurchase"
  FOR EACH ROW EXECUTE FUNCTION "refuse_channel_change"('sourceChannel');

CREATE TRIGGER "ProviderProfile_application_source_channel_immutable"
  BEFORE UPDATE OF "applicationSourceChannel" ON "ProviderProfile"
  FOR EACH ROW EXECUTE FUNCTION "refuse_channel_change"('applicationSourceChannel');
