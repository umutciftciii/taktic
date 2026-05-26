-- CreateEnum
CREATE TYPE "ProviderStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED');

-- CreateTable
CREATE TABLE "ProviderProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "businessName" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "taxType" TEXT,
    "taxNumber" TEXT,
    "city" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "addressNote" TEXT,
    "description" TEXT,
    "status" "ProviderStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "moderationNote" TEXT,
    "rejectionReason" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderServiceCategory" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderServiceCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderServiceArea" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "district" TEXT,
    "neighborhood" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderServiceArea_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderProfile_status_idx" ON "ProviderProfile"("status");

-- CreateIndex
CREATE INDEX "ProviderProfile_city_idx" ON "ProviderProfile"("city");

-- CreateIndex
CREATE INDEX "ProviderProfile_district_idx" ON "ProviderProfile"("district");

-- CreateIndex
CREATE INDEX "ProviderProfile_phone_idx" ON "ProviderProfile"("phone");

-- CreateIndex
CREATE INDEX "ProviderProfile_email_idx" ON "ProviderProfile"("email");

-- CreateIndex
CREATE INDEX "ProviderServiceCategory_categoryId_idx" ON "ProviderServiceCategory"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderServiceCategory_providerId_categoryId_key" ON "ProviderServiceCategory"("providerId", "categoryId");

-- CreateIndex
CREATE INDEX "ProviderServiceArea_city_idx" ON "ProviderServiceArea"("city");

-- CreateIndex
CREATE INDEX "ProviderServiceArea_district_idx" ON "ProviderServiceArea"("district");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderServiceArea_providerId_city_district_neighborhood_key" ON "ProviderServiceArea"("providerId", "city", "district", "neighborhood");

-- AddForeignKey
ALTER TABLE "ProviderProfile" ADD CONSTRAINT "ProviderProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderServiceCategory" ADD CONSTRAINT "ProviderServiceCategory_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderServiceCategory" ADD CONSTRAINT "ProviderServiceCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ServiceCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderServiceArea" ADD CONSTRAINT "ProviderServiceArea_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
