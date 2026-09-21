-- CMP-004 S4 (Migration G): the campaign audit log's system actor.
--
-- A payment reversal that revokes a promotion, or pauses a campaign past its
-- daily revoke threshold, is nobody's act; S3 had to record it against a
-- nominal person (the campaign's creator) because this column was NOT NULL.
-- This is the one ALTER COLUMN of the slice: the actor becomes optional, and
-- a CHECK ties every actor-less row to an explicit SYSTEM marker in the
-- summary, so a row with neither a person nor that marker cannot exist.
-- No DML: the S3 rows written with a nominal actor are left as they are.
ALTER TABLE "CampaignAuditLog" ALTER COLUMN "actorId" DROP NOT NULL;

ALTER TABLE "CampaignAuditLog"
  ADD CONSTRAINT "CampaignAuditLog_system_actor_marked"
  CHECK ("actorId" IS NOT NULL OR COALESCE("summary" ->> 'actorKind', '') = 'SYSTEM');
