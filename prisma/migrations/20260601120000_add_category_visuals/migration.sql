-- Add admin-managed visual columns to ServiceCategory.
-- All three columns are nullable with no default, so existing category rows
-- remain untouched and continue to fall back to the legacy iconForCategory(name)
-- behavior in the public web surfaces.

ALTER TABLE "ServiceCategory" ADD COLUMN "imageUrl" TEXT;
ALTER TABLE "ServiceCategory" ADD COLUMN "coverImageUrl" TEXT;
ALTER TABLE "ServiceCategory" ADD COLUMN "iconKey" TEXT;
