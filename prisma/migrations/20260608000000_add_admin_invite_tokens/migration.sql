-- CreateTable
CREATE TABLE "AdminInviteToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminInviteToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminInviteToken_tokenHash_key" ON "AdminInviteToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminInviteToken_userId_idx" ON "AdminInviteToken"("userId");

-- CreateIndex
CREATE INDEX "AdminInviteToken_createdById_idx" ON "AdminInviteToken"("createdById");

-- CreateIndex
CREATE INDEX "AdminInviteToken_expiresAt_idx" ON "AdminInviteToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "AdminInviteToken" ADD CONSTRAINT "AdminInviteToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminInviteToken" ADD CONSTRAINT "AdminInviteToken_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
