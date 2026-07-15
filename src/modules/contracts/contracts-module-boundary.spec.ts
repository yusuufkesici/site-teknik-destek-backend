import 'reflect-metadata';
import { BillingModule } from '../billing/billing.module';
import { TicketsModule } from '../tickets/tickets.module';
import { ContractsModule } from './contracts.module';
import { ContractLookupService } from './services/contract-lookup.service';

// Onaylanan Faz 7 plani Bolum 13/19: modul sinir bekcisi.
// - ContractsModule yalniz ContractLookupService export eder
//   (ContractRepository ASLA sizmamali).
// - BillingModule hicbir sey export etmez ve ContractsModule'u import eder.
// - Bagimlilik yonu tek tarafli: ContractsModule ne BillingModule ne
//   TicketsModule import eder (forwardRef/dongu yok).
describe('Faz 7 modul sinirlari', () => {
  function getMetadata(module: unknown, key: 'imports' | 'exports'): unknown[] {
    return (Reflect.getMetadata(key, module as object) as unknown[]) ?? [];
  }

  it('ContractsModule yalniz ContractLookupService export eder', () => {
    expect(getMetadata(ContractsModule, 'exports')).toEqual([ContractLookupService]);
  });

  it('BillingModule hicbir provider export etmez', () => {
    expect(getMetadata(BillingModule, 'exports')).toEqual([]);
  });

  it('BillingModule ve TicketsModule, ContractsModule import eder (tek yonlu bagimlilik)', () => {
    expect(getMetadata(BillingModule, 'imports')).toContain(ContractsModule);
    expect(getMetadata(TicketsModule, 'imports')).toContain(ContractsModule);
  });

  it('ContractsModule, BillingModule veya TicketsModule import ETMEZ (dongu yok)', () => {
    const imports = getMetadata(ContractsModule, 'imports');
    expect(imports).not.toContain(BillingModule);
    expect(imports).not.toContain(TicketsModule);
    // forwardRef kullanilmadigindan tum importlar duz sinif referansidir.
    for (const imported of imports) {
      expect(typeof imported).toBe('function');
    }
  });
});
