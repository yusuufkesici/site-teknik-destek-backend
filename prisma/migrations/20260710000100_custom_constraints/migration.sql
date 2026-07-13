-- prisma/migrations/20260710000100_custom_constraints/migration.sql
-- PostgreSQL'e ozgu, Prisma schema.prisma'nin ifade edemedigi kisitlar.
-- Kaynak: docs/architecture.md Bolum 6 + docs/implementation-overrides.md #4.
-- Bu migration, "_init" taban migration'i (tablolar/FK/normal index'ler)
-- uygulandiktan SONRA calistirilir.

-- Exclusion constraint icin gerekli uzanti
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 1) Ticket basina tek aktif assignment
CREATE UNIQUE INDEX uq_assignments_one_current_per_ticket
  ON assignments (ticket_id)
  WHERE is_current = true;

-- 2) Ayni parent altinda benzersiz facility kodu (soft delete haric)
CREATE UNIQUE INDEX uq_facilities_parent_code_alive
  ON facilities (parent_id, code)
  WHERE deleted_at IS NULL AND parent_id IS NOT NULL;

-- Kok SITE kodlari da kendi aralarinda benzersiz olsun
CREATE UNIQUE INDEX uq_facilities_site_code_alive
  ON facilities (code)
  WHERE deleted_at IS NULL AND type = 'SITE';

-- 3) Facility tip-alan tutarliligi (cross-row olmayan kisim)
ALTER TABLE facilities ADD CONSTRAINT chk_facility_root
  CHECK (
    (type = 'SITE' AND parent_id IS NULL AND site_id IS NULL)
    OR
    (type <> 'SITE' AND parent_id IS NOT NULL AND site_id IS NOT NULL)
  );
-- "BLOCK yalnizca SITE altinda", "UNIT yalnizca BLOCK altinda",
-- "parent baska site'a ait olamaz" kurallari parent SATIRINA bakmayi
-- gerektirdiginden, ileride ilgili domain servisinde (FacilityValidator)
-- transaction icinde parent SELECT ... FOR SHARE ile okunarak uygulanacaktir.

-- 4) Ayni site icin tarih araligi cakisan iki ACTIVE/SUSPENDED sozlesme engeli
ALTER TABLE contracts ADD CONSTRAINT excl_contracts_active_overlap
  EXCLUDE USING gist (
    site_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  )
  WHERE (status IN ('ACTIVE', 'SUSPENDED'));

-- 5) Sayisal ve tarihsel butunluk CHECK'leri
ALTER TABLE assignment_materials ADD CONSTRAINT chk_am_quantity_positive
  CHECK (quantity > 0);
ALTER TABLE assignment_materials ADD CONSTRAINT chk_am_unit_price_nonneg
  CHECK (unit_price >= 0);
ALTER TABLE assignment_materials ADD CONSTRAINT chk_am_total_consistent
  CHECK (total_price = round(quantity * unit_price, 2));

ALTER TABLE contracts ADD CONSTRAINT chk_contract_dates
  CHECK (end_date > start_date);
ALTER TABLE contracts ADD CONSTRAINT chk_contract_billing_day
  CHECK (billing_day BETWEEN 1 AND 28);
ALTER TABLE contracts ADD CONSTRAINT chk_contract_fee_nonneg
  CHECK (monthly_fee >= 0);

ALTER TABLE contract_invoices ADD CONSTRAINT chk_invoice_period
  CHECK (billing_period_end > billing_period_start);
ALTER TABLE contract_invoices ADD CONSTRAINT chk_invoice_amount_nonneg
  CHECK (amount >= 0);

-- Ayni sozlesmede cakisan fatura donemi engeli (unique start'a ek guvence)
ALTER TABLE contract_invoices ADD CONSTRAINT excl_invoice_period_overlap
  EXCLUDE USING gist (
    contract_id WITH =,
    daterange(billing_period_start, billing_period_end, '[)') WITH &&
  )
  WHERE (status <> 'CANCELLED');

-- 6) E.164 format garantisi
ALTER TABLE users ADD CONSTRAINT chk_users_phone_e164
  CHECK (phone_number ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE otp_challenges ADD CONSTRAINT chk_otp_phone_e164
  CHECK (phone_number ~ '^\+[1-9][0-9]{6,14}$');

-- 7) OTP deneme butunlugu
ALTER TABLE otp_challenges ADD CONSTRAINT chk_otp_attempts
  CHECK (attempt_count >= 0 AND attempt_count <= max_attempts);

-- 8) Aktif uyelik/oturum tekilligi
CREATE UNIQUE INDEX uq_site_membership_active
  ON site_memberships (user_id, site_id, membership_role)
  WHERE is_active = true;

CREATE UNIQUE INDEX uq_resident_unit_active
  ON resident_unit_assignments (user_id, unit_id)
  WHERE is_active = true;

-- 9) Ticket kodu icin sequence
CREATE SEQUENCE IF NOT EXISTS ticket_code_seq;

-- 10) Attachment/assignment butunlugu (docs/implementation-overrides.md #4)
--     Bir TicketAttachment icinde assignmentId verilmisse, assignment ayni
--     ticketId degerine ait olmak zorundadir. Uygulama katmani bunu ayrica
--     transaction icinde dogrular (ATTACHMENT_ASSIGNMENT_MISMATCH); burada
--     DB seviyesinde composite FK ile garanti altina alinir.
--     Non-partial unique constraint, composite FK'nin referans verebilmesi
--     icin FK'den ONCE olusturulmalidir.
ALTER TABLE assignments ADD CONSTRAINT uq_assignments_id_ticket
  UNIQUE (id, ticket_id);

ALTER TABLE ticket_attachments ADD CONSTRAINT fk_attachment_assignment_ticket
  FOREIGN KEY (assignment_id, ticket_id)
  REFERENCES assignments (id, ticket_id);
