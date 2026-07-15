import { ContractLookupService } from './contract-lookup.service';

// Eski src/modules/tickets/services/contract-query.service.ts davranisinin
// BIREBIR tasindiginin bekcisi (onaylanan Faz 7 plani Bolum 15): ayni sorgu
// semantigi, ayni ActiveContractRow alanlari, ayni transaction-client kabulu.
describe('ContractLookupService', () => {
  function buildService() {
    const contractRepo = {
      findByIdForUpdate: jest.fn(),
      findById: jest.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new ContractLookupService(contractRepo as any);
    return { service, contractRepo };
  }

  describe('findActiveForSite (Faz 4 tasima)', () => {
    it('ilk satiri ActiveContractRow olarak doner', async () => {
      const { service } = buildService();
      const row = { id: 'c-1', standardResponseTargetHours: 48, emergencyCoverage: true };
      const client = { $queryRaw: jest.fn().mockResolvedValue([row]) };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await service.findActiveForSite('site-1', client as any);

      expect(result).toEqual(row);
      expect(client.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('satir yoksa null doner', async () => {
      const { service } = buildService();
      const client = { $queryRaw: jest.fn().mockResolvedValue([]) };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await service.findActiveForSite('site-1', client as any);

      expect(result).toBeNull();
    });

    it('sorgu status=ACTIVE ve CURRENT_DATE tarih araligi kosullarini icerir (DB tarafinda)', async () => {
      const { service } = buildService();
      const client = { $queryRaw: jest.fn().mockResolvedValue([]) };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await service.findActiveForSite('site-1', client as any);

      const [templateParts] = client.$queryRaw.mock.calls[0] as [TemplateStringsArray];
      const sql = templateParts.join('?');
      expect(sql).toContain("status = 'ACTIVE'");
      expect(sql).toContain('start_date <= CURRENT_DATE');
      expect(sql).toContain('end_date >= CURRENT_DATE');
      expect(sql).toContain('standard_response_target_hours AS "standardResponseTargetHours"');
      expect(sql).toContain('emergency_coverage AS "emergencyCoverage"');
    });

    it('verilen client (transaction dahil) dogrudan kullanilir', async () => {
      const { service } = buildService();
      const txClient = { $queryRaw: jest.fn().mockResolvedValue([]) };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await service.findActiveForSite('site-1', txClient as any);

      expect(txClient.$queryRaw).toHaveBeenCalled();
    });
  });

  describe('findByIdForUpdate / findById (BillingModule yuzeyi)', () => {
    it('findByIdForUpdate repository delegasyonudur (kilitli okuma)', async () => {
      const { service, contractRepo } = buildService();
      const row = { id: 'c-1', status: 'ACTIVE' };
      contractRepo.findByIdForUpdate.mockResolvedValue(row);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await service.findByIdForUpdate('tx' as any, 'c-1');

      expect(result).toBe(row);
      expect(contractRepo.findByIdForUpdate).toHaveBeenCalledWith('tx', 'c-1');
    });

    it('findById repository delegasyonudur (kilitsiz okuma)', async () => {
      const { service, contractRepo } = buildService();
      contractRepo.findById.mockResolvedValue(null);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await service.findById('client' as any, 'c-2');

      expect(result).toBeNull();
      expect(contractRepo.findById).toHaveBeenCalledWith('client', 'c-2');
    });
  });
});
