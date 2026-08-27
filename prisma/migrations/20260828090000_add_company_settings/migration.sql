-- Company branding as admin-managed business data.
--
-- Additive only: one new table, one foreign key onto "User", no column altered
-- and no row touched anywhere else. Nothing is seeded — this migration has no
-- way to know a company's legal name or support address, and inventing one
-- would put a plausible falsehood in front of every customer. The table stays
-- empty until an operator saves it from the admin panel.

CREATE TABLE "CompanySettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "legalName" TEXT NOT NULL,
    "supportEmail" TEXT NOT NULL,
    "postalAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "CompanySettings_pkey" PRIMARY KEY ("id")
);

-- "Exactly one row" as a database guarantee rather than an application
-- convention: the primary key already makes the id unique, and this refuses
-- every id but the one the service upserts on.
ALTER TABLE "CompanySettings"
    ADD CONSTRAINT "CompanySettings_singleton_check" CHECK ("id" = 'singleton');

CREATE INDEX "CompanySettings_updatedById_idx" ON "CompanySettings"("updatedById");

ALTER TABLE "CompanySettings"
    ADD CONSTRAINT "CompanySettings_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
