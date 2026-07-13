import { computeSlaTargetAt } from './sla.util';

const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const EMERGENCY_SLA_HOURS = 2;

describe('computeSlaTargetAt', () => {
  it('contract yoksa null doner', () => {
    expect(computeSlaTargetAt(CREATED_AT, 'STANDARD', null, EMERGENCY_SLA_HOURS)).toBeNull();
  });

  it('EMERGENCY + emergencyCoverage=true -> emergencySlaHours kullanilir', () => {
    const result = computeSlaTargetAt(
      CREATED_AT,
      'EMERGENCY',
      { id: 'c-1', standardResponseTargetHours: 48, emergencyCoverage: true },
      EMERGENCY_SLA_HOURS,
    );
    expect(result).toEqual(new Date(CREATED_AT.getTime() + EMERGENCY_SLA_HOURS * 3_600_000));
  });

  it('EMERGENCY + emergencyCoverage=false -> standardResponseTargetHours kullanilir', () => {
    const result = computeSlaTargetAt(
      CREATED_AT,
      'EMERGENCY',
      { id: 'c-1', standardResponseTargetHours: 24, emergencyCoverage: false },
      EMERGENCY_SLA_HOURS,
    );
    expect(result).toEqual(new Date(CREATED_AT.getTime() + 24 * 3_600_000));
  });

  it('EMERGENCY + emergencyCoverage=false + standardResponseTargetHours=null -> null', () => {
    const result = computeSlaTargetAt(
      CREATED_AT,
      'EMERGENCY',
      { id: 'c-1', standardResponseTargetHours: null, emergencyCoverage: false },
      EMERGENCY_SLA_HOURS,
    );
    expect(result).toBeNull();
  });

  it('STANDARD urgency -> standardResponseTargetHours kullanilir (emergencyCoverage etkisiz)', () => {
    const result = computeSlaTargetAt(
      CREATED_AT,
      'STANDARD',
      { id: 'c-1', standardResponseTargetHours: 72, emergencyCoverage: true },
      EMERGENCY_SLA_HOURS,
    );
    expect(result).toEqual(new Date(CREATED_AT.getTime() + 72 * 3_600_000));
  });

  it('standardResponseTargetHours=null ise diger urgency degerlerinde de null doner', () => {
    const result = computeSlaTargetAt(
      CREATED_AT,
      'URGENT',
      { id: 'c-1', standardResponseTargetHours: null, emergencyCoverage: true },
      EMERGENCY_SLA_HOURS,
    );
    expect(result).toBeNull();
  });
});
