-- NOT: Prisma'nin otomatik diff motoru burada "fk_attachment_assignment_ticket"
-- FK'sini ve "uq_assignments_id_ticket" index'ini DROP etmeyi onerdi. Bu ikisi
-- Faz 8'in parcasi DEGILDIR - implementation-overrides.md #4 (composite FK
-- attachment/assignment/ticket butunlugu) kapsaminda 20260710000100_custom_constraints
-- migration'inda el ile eklenmis, Prisma schema DSL'inin ifade edemedigi
-- kisitlardir. schema.prisma bunlari hic bilmedigi icin Prisma bunlari
-- "drift" sanip kaldirmayi onerdi - bilincli olarak bu iki ifade BU
-- migration'dan CIKARILDI, hicbir mevcut constraint/index dokunulmadan kalir.

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "failed_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "source_event_id" UUID NOT NULL,
    "source_event_type" VARCHAR(100) NOT NULL,
    "channel" VARCHAR(20) NOT NULL,
    "sms_method" VARCHAR(30) NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "recipient_phone" VARCHAR(16) NOT NULL,
    "message" VARCHAR(500) NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "processed_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "last_error" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_deliveries_status_next_attempt_at_idx" ON "notification_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_source_event_id_recipient_phone_cha_key" ON "notification_deliveries"("source_event_id", "recipient_phone", "channel");

-- Tek seferlik veri temizligi (onaylanan docs/phase-8-plan.md Bolum 9.1,
-- kritik karar #3): Faz 4'ten beri biriken, hic tuketilmemis PENDING/
-- PROCESSING outbox_events satirlari, Faz 8 relay'i devreye girdiginde eski
-- olaylardan (ör. gecmis EmergencyTicketCreated/TechnicianAssigned) SMS
-- uretmesin diye PROCESSED olarak isaretlenir. Hedef kosul YALNIZ status
-- IN ('PENDING','PROCESSING') olan satirlardir - bu migration'in
-- calistigi andan SONRA uretilen hicbir satiri etkilemez (WHERE bu
-- migration'in cografi/zamansal noktasinda mevcut olan satirlarla
-- sinirlidir). last_error alani, teknik bir hata olmasa da bu tek seferlik
-- atlamanin adli iz kaydi olarak kasitli sekilde yeniden kullanilir.
UPDATE "outbox_events"
SET "status" = 'PROCESSED',
    "processed_at" = now(),
    "last_error" = 'SKIPPED_PRE_PHASE8_BACKLOG'
WHERE "status" IN ('PENDING', 'PROCESSING');
