-- A platform account may own at most one provider profile.
-- The column stays nullable so guest (unclaimed) applications keep working:
-- PostgreSQL treats NULLs as distinct in a unique index, so this constraint
-- only binds rows where "userId" IS NOT NULL.
CREATE UNIQUE INDEX "ProviderProfile_userId_key" ON "ProviderProfile"("userId");
