-- Trigram indexes for the offer list's search resolvers (OFFERS-SEARCH-OPT-001).
--
-- `/offers?q=` no longer joins the provider and the request to every offer.
-- The search is resolved table by table first, on the list's own transaction
-- (apps/api/src/modules/offers/offer-search.ts), and the offer statements read
-- `id IN (…) OR providerId IN (…) OR requestId IN (…)` — served by
-- "Offer_pkey", "Offer_providerId_idx"/"Offer_providerId_requestId_key" and
-- "Offer_requestId_idx". What is left to index is each resolver's own OR:
--
--   * Offer:           id
--   * ProviderProfile: id, contactName, contactNameSearch (PROVIDERS_READ),
--                      beside the existing businessName, businessNameSearch and
--                      phone trigram indexes
--   * ServiceRequest:  id, city, citySearch, district, districtSearch, and —
--                      for REQUESTS_READ — customerName, customerNameSearch,
--                      customerEmail, customerPhone
--
-- The planner combines a resolver's arms (BitmapOr) only when every arm has an
-- index; with any one missing it reads the table. Measured on a disposable copy
-- (60k providers, 180k requests, 450k offers; EXPLAIN ANALYZE of the statements
-- Prisma sends): the resolvers fell from 35–95 ms (sequential scans) to
-- 0–8 ms, and the whole list call for a selective box from 2.7–3.7 s before
-- this change (≈0.2–0.45 s with the resolvers alone) to 17–68 ms. Every index
-- below was used by the planner in those plans, for the readers whose search
-- includes its column. The exact phone spellings (`IN (…)`) keep using
-- "ProviderProfile_phone_idx" and "ServiceRequest_customerPhone_submittedAt_idx".
-- A box shorter than three characters has no trigram and still scans, as before.
--
-- Write cost, same copy: 10k request inserts +≈170 ms in total (≈17 µs each);
-- 10k offer inserts within measurement noise.
--
-- pg_trgm is already installed (20261010120000_add_admin_search_trigram_indexes).
-- Plain CREATE INDEX (Prisma runs a migration in one transaction); it blocks
-- writes to each table while it builds: well under a second at today's size
-- (0.5 s for "Offer" at 450k rows on the copy).
--
-- Rollback (nothing depends on these indexes):
--
--   DROP INDEX "Offer_id_trgm_idx",
--     "ProviderProfile_id_trgm_idx", "ProviderProfile_contactName_trgm_idx", "ProviderProfile_contactNameSearch_trgm_idx",
--     "ServiceRequest_id_trgm_idx", "ServiceRequest_customerName_trgm_idx", "ServiceRequest_customerNameSearch_trgm_idx",
--     "ServiceRequest_customerEmail_trgm_idx", "ServiceRequest_customerPhone_trgm_idx", "ServiceRequest_city_trgm_idx",
--     "ServiceRequest_citySearch_trgm_idx", "ServiceRequest_district_trgm_idx", "ServiceRequest_districtSearch_trgm_idx";

-- CreateIndex
CREATE INDEX "Offer_id_trgm_idx" ON "Offer" USING GIN ("id" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "ProviderProfile_id_trgm_idx" ON "ProviderProfile" USING GIN ("id" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "ProviderProfile_contactName_trgm_idx" ON "ProviderProfile" USING GIN ("contactName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "ProviderProfile_contactNameSearch_trgm_idx" ON "ProviderProfile" USING GIN ("contactNameSearch" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "ServiceRequest_id_trgm_idx" ON "ServiceRequest" USING GIN ("id" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "ServiceRequest_customerName_trgm_idx" ON "ServiceRequest" USING GIN ("customerName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "ServiceRequest_customerNameSearch_trgm_idx" ON "ServiceRequest" USING GIN ("customerNameSearch" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "ServiceRequest_customerEmail_trgm_idx" ON "ServiceRequest" USING GIN ("customerEmail" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "ServiceRequest_customerPhone_trgm_idx" ON "ServiceRequest" USING GIN ("customerPhone" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "ServiceRequest_city_trgm_idx" ON "ServiceRequest" USING GIN ("city" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "ServiceRequest_citySearch_trgm_idx" ON "ServiceRequest" USING GIN ("citySearch" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "ServiceRequest_district_trgm_idx" ON "ServiceRequest" USING GIN ("district" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "ServiceRequest_districtSearch_trgm_idx" ON "ServiceRequest" USING GIN ("districtSearch" gin_trgm_ops);
