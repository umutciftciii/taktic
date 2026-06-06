-- CreateTable
CREATE TABLE "CustomerActivationToken" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerActivationToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerActivationToken_tokenHash_key" ON "CustomerActivationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "CustomerActivationToken_customerId_idx" ON "CustomerActivationToken"("customerId");

-- CreateIndex
CREATE INDEX "CustomerActivationToken_createdById_idx" ON "CustomerActivationToken"("createdById");

-- CreateIndex
CREATE INDEX "CustomerActivationToken_expiresAt_idx" ON "CustomerActivationToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "CustomerActivationToken" ADD CONSTRAINT "CustomerActivationToken_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerActivationToken" ADD CONSTRAINT "CustomerActivationToken_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
