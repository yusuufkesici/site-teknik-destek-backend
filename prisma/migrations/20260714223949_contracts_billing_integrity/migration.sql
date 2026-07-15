-- prisma/migrations/20260714223949_contracts_billing_integrity/migration.sql
-- Faz 7 (Contracts & Billing): sequence'ler + fatura/sozlesme butunluk
-- trigger'lari + yeni CHECK kisitlari + kosulsuz fatura-donem unique'inin
-- partial unique'e donusturulmesi.
-- Kaynak: onaylanan Faz 7 plani (docs/phase-7-plan.md) Bolum 11.
-- Mevcut init/custom_constraints migration'lari DEGISTIRILMEZ.
--
-- NOT (hibrit akis, plan Bolum 11.2): asagidaki DROP INDEX,
-- `prisma migrate dev --create-only` ciktisindan alinmistir. Uretilen ham
-- ciktida ayrica fk_attachment_assignment_ticket ve uq_assignments_id_ticket
-- (Faz 6, docs/implementation-overrides.md #4 butunluk nesneleri) icin de
-- DROP uretilmisti - bunlar PSL'de temsil edilmeyen ama introspection'in
-- gordugu nesnelerdir; KASITLI olarak bu migration'dan cikarildi, Faz 6
-- garantileri aynen korunur.

-- 0) Kosulsuz fatura-donem unique'inin kaldirilmasi (Prisma diff ciktisi)
DROP INDEX "contract_invoices_contract_id_billing_period_start_key";

-- 1) Sozlesme/fatura numarasi icin sequence'ler (ticket_code_seq emsali).
--    Rollback'te numara boslugu normaldir; kesintisiz yasal numaralandirma
--    garantisi verilmez (plan Bolum 4.10).
CREATE SEQUENCE IF NOT EXISTS contract_number_seq;
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq;

-- 2) Kosulsuz unique yerine CANCELLED-disi partial unique
--    (iptal + ayni donem icin yeniden olusturma, plan Bolum 4.11).
CREATE UNIQUE INDEX uq_contract_invoices_period_start_open
  ON contract_invoices(contract_id, billing_period_start)
  WHERE status <> 'CANCELLED';

-- 3) dueDate >= issueDate
ALTER TABLE contract_invoices ADD CONSTRAINT chk_invoice_due_after_issue
  CHECK (due_date >= issue_date);

-- 4) PAID/odeme alani tutarliligi (uygulama on-kontrolunun DB backstop'u)
ALTER TABLE contract_invoices ADD CONSTRAINT chk_invoice_payment_consistency
  CHECK (
    (status = 'PAID' AND paid_at IS NOT NULL AND payment_method IS NOT NULL
      AND (payment_method <> 'BANK_TRANSFER'
           OR (reference_number IS NOT NULL AND btrim(reference_number) <> '')))
    OR
    (status <> 'PAID' AND paid_at IS NULL AND payment_method IS NULL
      AND reference_number IS NULL)
  );

-- 5) TERMINATED/termination alani tutarliligi (backstop)
ALTER TABLE contracts ADD CONSTRAINT chk_contract_termination_consistency
  CHECK (
    (status = 'TERMINATED' AND terminated_at IS NOT NULL
      AND termination_reason IS NOT NULL AND btrim(termination_reason) <> '')
    OR
    (status <> 'TERMINATED' AND terminated_at IS NULL
      AND termination_reason IS NULL)
  );

-- 6) Fatura butunluk trigger'i: parent varligi + billability + donem
--    penceresi (TERMINATED icin LEAST formulu) + currency esitligi.
--    Parent okuma FOR SHARE ile yapilir (FOR KEY SHARE DEGIL): siradan
--    UPDATE'in aldigi FOR NO KEY UPDATE kilidiyle cakisarak dogrudan-DB
--    invoice insert'i ile contract guncellemesini serilestirir
--    (plan Bolum 11.3).
CREATE OR REPLACE FUNCTION fn_invoice_period_within_contract()
RETURNS TRIGGER AS $$
DECLARE
  v_start DATE;
  v_end DATE;
  v_status "ContractStatus";
  v_terminated_at TIMESTAMPTZ;
  v_currency VARCHAR(3);
  v_window_end DATE;
BEGIN
  SELECT start_date, end_date, status, terminated_at, currency
    INTO v_start, v_end, v_status, v_terminated_at, v_currency
    FROM contracts WHERE id = NEW.contract_id
    FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'chk_invoice_contract_exists: contract % not found for invoice validation', NEW.contract_id
      USING ERRCODE = 'P0001', CONSTRAINT = 'chk_invoice_contract_exists';
  END IF;

  IF v_status IN ('DRAFT', 'SUSPENDED') THEN
    RAISE EXCEPTION 'chk_invoice_contract_not_billable: contract % is not billable in status %', NEW.contract_id, v_status
      USING ERRCODE = 'P0001', CONSTRAINT = 'chk_invoice_contract_not_billable';
  END IF;

  IF v_status = 'TERMINATED' THEN
    v_window_end := LEAST(v_end + 1, (v_terminated_at AT TIME ZONE 'UTC')::date + 1);
  ELSE
    v_window_end := v_end + 1;
  END IF;

  IF NEW.billing_period_start < v_start OR NEW.billing_period_end > v_window_end THEN
    RAISE EXCEPTION 'chk_invoice_period_within_contract: invoice period % - % outside billable window of contract % (% - %)',
      NEW.billing_period_start, NEW.billing_period_end, NEW.contract_id, v_start, v_window_end
      USING ERRCODE = 'P0001', CONSTRAINT = 'chk_invoice_period_within_contract';
  END IF;

  IF NEW.currency <> v_currency THEN
    RAISE EXCEPTION 'chk_invoice_currency_match: invoice currency % does not match contract % currency %',
      NEW.currency, NEW.contract_id, v_currency
      USING ERRCODE = 'P0001', CONSTRAINT = 'chk_invoice_currency_match';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoice_period_within_contract
  BEFORE INSERT OR UPDATE OF contract_id, billing_period_start, billing_period_end, currency
  ON contract_invoices
  FOR EACH ROW EXECUTE FUNCTION fn_invoice_period_within_contract();

-- 7) Contract termination, var olan (non-CANCELLED) faturalari
--    gecersizlestiremez (plan Bolum 4.5).
CREATE OR REPLACE FUNCTION fn_contract_termination_invoice_conflict()
RETURNS TRIGGER AS $$
DECLARE
  v_window_end DATE;
  v_conflict_count INT;
BEGIN
  v_window_end := LEAST(NEW.end_date + 1, (NEW.terminated_at AT TIME ZONE 'UTC')::date + 1);

  SELECT count(*) INTO v_conflict_count
  FROM contract_invoices
  WHERE contract_id = NEW.id
    AND status <> 'CANCELLED'
    AND billing_period_end > v_window_end;

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'chk_contract_termination_invoice_conflict: contract % termination conflicts with % existing invoice(s) beyond window %',
      NEW.id, v_conflict_count, v_window_end
      USING ERRCODE = 'P0001', CONSTRAINT = 'chk_contract_termination_invoice_conflict';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_contract_termination_invoice_conflict
  BEFORE UPDATE OF status, terminated_at
  ON contracts
  FOR EACH ROW
  WHEN (NEW.status = 'TERMINATED')
  EXECUTE FUNCTION fn_contract_termination_invoice_conflict();
