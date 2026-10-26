-- AlterTable
ALTER TABLE "Version" ADD COLUMN     "diffSummary" JSONB,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'FULL',
ADD COLUMN     "parentId" TEXT;

-- AddForeignKey
ALTER TABLE "Version" ADD CONSTRAINT "Version_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
