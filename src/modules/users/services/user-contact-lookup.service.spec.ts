import { UserContactLookupService } from './user-contact-lookup.service';

function buildService() {
  const userRepo = {
    findActivePhoneById: jest.fn(),
    findActivePhonesByIds: jest.fn(),
    listActiveByRole: jest.fn(),
  };
  const service = new UserContactLookupService({} as never, userRepo as never);
  return { service, userRepo };
}

describe('UserContactLookupService', () => {
  it('findActivePhoneById: bulunan kaydin telefonunu normalize edip userId ile birlikte doner', async () => {
    const { service, userRepo } = buildService();
    userRepo.findActivePhoneById.mockResolvedValue({
      id: 'user-1',
      phoneNumber: '+905551112233',
    });

    const result = await service.findActivePhoneById('user-1');

    expect(result).toEqual({ userId: 'user-1', phoneNumber: '+905551112233' });
  });

  it('findActivePhoneById: kayit yoksa (inaktif/silinmis dahil) null doner', async () => {
    const { service, userRepo } = buildService();
    userRepo.findActivePhoneById.mockResolvedValue(null);

    expect(await service.findActivePhoneById('user-1')).toBeNull();
  });

  it('findActivePhonesByIds: bosluklu ama gecerli formati normalize eder', async () => {
    const { service, userRepo } = buildService();
    userRepo.findActivePhonesByIds.mockResolvedValue([
      { id: 'user-1', phoneNumber: '+90 555 111 22 33' },
    ]);

    const result = await service.findActivePhonesByIds(['user-1']);

    expect(result).toEqual([{ userId: 'user-1', phoneNumber: '+905551112233' }]);
  });

  it('normalize edilemeyen (yapisal olarak imkansiz ama savunmaci kontrol) kayitlari guvenle atlar', async () => {
    const { service, userRepo } = buildService();
    userRepo.listActiveByRole.mockResolvedValue([
      { id: 'user-1', phoneNumber: 'gecersiz-telefon' },
      { id: 'user-2', phoneNumber: '+905551112233' },
    ]);

    const result = await service.listActiveOperationsPhones();

    expect(result).toEqual([{ userId: 'user-2', phoneNumber: '+905551112233' }]);
  });

  it('listActiveOperationsPhones: repository metodunu role=OPERATIONS ile cagirir', async () => {
    const { service, userRepo } = buildService();
    userRepo.listActiveByRole.mockResolvedValue([]);

    await service.listActiveOperationsPhones();

    expect(userRepo.listActiveByRole).toHaveBeenCalledWith(expect.anything(), 'OPERATIONS');
  });
});
