-- CreateTable
CREATE TABLE "CancellationPolicy" (
    "id" TEXT NOT NULL,
    "productKind" "OrderItemKind" NOT NULL,
    "scope" TEXT,
    "name" TEXT NOT NULL,
    "tiers" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CancellationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CancellationPolicy_productKind_isDefault_idx" ON "CancellationPolicy"("productKind", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "CancellationPolicy_productKind_scope_key" ON "CancellationPolicy"("productKind", "scope");
