-- CreateEnum
CREATE TYPE "RequestDraftFormType" AS ENUM ('MARKETPLACE', 'SHOWCASE_LEAD');

-- CreateTable
CREATE TABLE "RequestDraft" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "formType" "RequestDraftFormType" NOT NULL,
    "categorySlug" TEXT NOT NULL,
    "cardId" TEXT,
    "payload" JSONB NOT NULL,
    "expectedUserId" TEXT,
    "userId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RequestDraft_tokenHash_key" ON "RequestDraft"("tokenHash");
CREATE INDEX "RequestDraft_expiresAt_idx" ON "RequestDraft"("expiresAt");
CREATE INDEX "RequestDraft_expectedUserId_idx" ON "RequestDraft"("expectedUserId");
CREATE INDEX "RequestDraft_userId_idx" ON "RequestDraft"("userId");

-- AddForeignKey
ALTER TABLE "RequestDraft" ADD CONSTRAINT "RequestDraft_expectedUserId_fkey" FOREIGN KEY ("expectedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RequestDraft" ADD CONSTRAINT "RequestDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
