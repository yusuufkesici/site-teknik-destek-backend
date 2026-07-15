import { Prisma } from '../../generated/prisma-client/client';
import {
  getConstraintName,
  getUniqueConstraintTarget,
  isCheckConstraintViolation,
  isExclusionConstraintViolation,
  isRaisedConstraintViolation,
  isUniqueConstraintViolation,
} from './prisma-error.util';

// Mock sekilleri, constraint-violation-shapes.integration-spec.ts spike'inin
// gercek PostgreSQL 16 + Prisma 7.8.0 + @prisma/adapter-pg uzerinde
// GOZLEMLEDIGI sekillerin birebir kopyasidir (plan Bolum 19) - hizli unit
// regresyon; gercek dogrulama integration spike'inda surekli calisir.

function driverAdapterError(code: string, message: string): unknown {
  return Object.assign(new Error(message), {
    name: 'DriverAdapterError',
    cause: {
      kind: 'postgres',
      code,
      originalCode: code,
      message,
      originalMessage: message,
      severity: 'ERROR',
    },
  });
}

function p2002Error(fields: string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('unique violation', {
    code: 'P2002',
    clientVersion: '7.8.0',
    meta: {
      modelName: 'Contract',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          originalMessage: 'duplicate key value violates unique constraint "x"',
          kind: 'UniqueConstraintViolation',
          constraint: { fields },
        },
      },
    },
  });
}

describe('prisma-error.util (Faz 7 yardimcilari)', () => {
  const exclusionError = driverAdapterError(
    '23P01',
    'conflicting key value violates exclusion constraint "excl_contracts_active_overlap"',
  );
  const checkError = driverAdapterError(
    '23514',
    'new row for relation "contract_invoices" violates check constraint "chk_invoice_due_after_issue"',
  );
  const raisedError = driverAdapterError(
    'P0001',
    'chk_invoice_currency_match: invoice currency USD does not match contract x currency TRY',
  );

  describe('isExclusionConstraintViolation', () => {
    it('23P01 hatasini tanir ve constraint adiyla eslestirir', () => {
      expect(isExclusionConstraintViolation(exclusionError)).toBe(true);
      expect(isExclusionConstraintViolation(exclusionError, 'excl_contracts_active_overlap')).toBe(
        true,
      );
      expect(isExclusionConstraintViolation(exclusionError, 'excl_invoice_period_overlap')).toBe(
        false,
      );
    });

    it('diger SQLSTATE kodlarinda false doner', () => {
      expect(isExclusionConstraintViolation(checkError)).toBe(false);
      expect(isExclusionConstraintViolation(raisedError)).toBe(false);
    });
  });

  describe('isCheckConstraintViolation', () => {
    it('23514 hatasini tanir ve constraint adiyla eslestirir', () => {
      expect(isCheckConstraintViolation(checkError)).toBe(true);
      expect(isCheckConstraintViolation(checkError, 'chk_invoice_due_after_issue')).toBe(true);
      expect(isCheckConstraintViolation(checkError, 'chk_invoice_payment_consistency')).toBe(false);
    });
  });

  describe('isRaisedConstraintViolation', () => {
    it('P0001 hatasini tanir; ad, mesajdaki kontrollu on ekten okunur', () => {
      expect(isRaisedConstraintViolation(raisedError)).toBe(true);
      expect(isRaisedConstraintViolation(raisedError, 'chk_invoice_currency_match')).toBe(true);
      expect(isRaisedConstraintViolation(raisedError, 'chk_invoice_contract_exists')).toBe(false);
    });
  });

  describe('getConstraintName', () => {
    it('23P01/23514 icin PG mesaj formatindan, P0001 icin on ekten ad cikarir', () => {
      expect(getConstraintName(exclusionError)).toBe('excl_contracts_active_overlap');
      expect(getConstraintName(checkError)).toBe('chk_invoice_due_after_issue');
      expect(getConstraintName(raisedError)).toBe('chk_invoice_currency_match');
    });
  });

  describe('getUniqueConstraintTarget', () => {
    it('P2002 driver-adapter yolunda constraint.fields listesini doner', () => {
      expect(getUniqueConstraintTarget(p2002Error(['contract_number']))).toEqual([
        'contract_number',
      ]);
    });

    it('P2002 olmayan hatalarda undefined doner', () => {
      expect(getUniqueConstraintTarget(exclusionError)).toBeUndefined();
      expect(getUniqueConstraintTarget(new Error('x'))).toBeUndefined();
    });
  });

  describe('negatif durumlar (Prisma/PG disi hatalar)', () => {
    const plain = new Error('siradan hata');

    it('duz Error/null/undefined hepsinde false/undefined doner', () => {
      expect(isExclusionConstraintViolation(plain)).toBe(false);
      expect(isCheckConstraintViolation(plain)).toBe(false);
      expect(isRaisedConstraintViolation(plain)).toBe(false);
      expect(getConstraintName(plain)).toBeUndefined();
      expect(isExclusionConstraintViolation(null)).toBe(false);
      expect(isExclusionConstraintViolation(undefined)).toBe(false);
      expect(getConstraintName(null)).toBeUndefined();
    });

    it('P2002 mevcut yardimciyla tanınir, exclusion/check/raised ile karismaz', () => {
      const p2002 = p2002Error(['contract_number']);
      expect(isUniqueConstraintViolation(p2002)).toBe(true);
      expect(isExclusionConstraintViolation(p2002)).toBe(false);
      expect(isCheckConstraintViolation(p2002)).toBe(false);
      expect(isRaisedConstraintViolation(p2002)).toBe(false);
    });

    it("cause'u postgres olmayan DriverAdapterError'da false doner", () => {
      const nonPg = Object.assign(new Error('x'), {
        name: 'DriverAdapterError',
        cause: { kind: 'sqlite', code: '23P01' },
      });
      expect(isExclusionConstraintViolation(nonPg)).toBe(false);
    });
  });
});
