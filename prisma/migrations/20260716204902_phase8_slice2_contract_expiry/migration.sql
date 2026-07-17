-- NOT: Prisma'nin otomatik diff motoru burada da (Slice 1'deki ayni sebeple)
-- "fk_attachment_assignment_ticket" FK'sini ve "uq_assignments_id_ticket"
-- index'ini DROP etmeyi onerdi. Bu ikisi Faz 8'in parcasi DEGILDIR -
-- implementation-overrides.md #4 kapsaminda 20260710000100_custom_constraints
-- migration'inda el ile eklenmis, Prisma schema DSL'inin ifade edemedigi
-- kisitlardir. Bilincli olarak bu iki ifade BU migration'dan CIKARILDI,
-- hicbir mevcut constraint/index dokunulmadan kalir.

-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "expiry_notified_at" TIMESTAMPTZ(6);

-- CreateIndex
CREATE INDEX "contracts_status_end_date_idx" ON "contracts"("status", "end_date");
