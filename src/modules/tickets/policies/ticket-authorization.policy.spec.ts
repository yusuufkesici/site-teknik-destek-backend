import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import type { TicketRow } from '../repositories/ticket.repository';
import { TicketAuthorizationPolicy } from './ticket-authorization.policy';

function actor(role: AuthenticatedUser['role'], id = 'actor-1'): AuthenticatedUser {
  return { id, role, sessionId: 's', tokenVersion: 0 };
}

function buildTicket(overrides: Partial<TicketRow> = {}): TicketRow {
  return {
    id: 'ticket-1',
    code: 'TKT-2026-000001',
    createdByUserId: 'resident-1',
    siteId: 'site-1',
    facilityId: 'unit-1',
    title: 'Ariza',
    description: 'Detay',
    category: 'ELECTRICAL',
    urgency: 'STANDARD',
    status: 'OPEN',
    source: 'RESIDENT',
    slaTargetAt: null,
    isRecurring: false,
    operationNote: null,
    completedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function buildFacility(overrides: Record<string, unknown> = {}) {
  return {
    id: 'unit-1',
    type: 'UNIT',
    name: 'D-1',
    code: 'D-1',
    parentId: 'block-1',
    siteId: 'site-1',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function buildPolicy() {
  const membershipQuery = {
    hasActiveSiteMembership: jest.fn().mockResolvedValue(true),
    hasActiveManagerMembership: jest.fn().mockResolvedValue(true),
  };
  const residentUnitAssignmentRepo = {
    findActiveForUser: jest.fn().mockResolvedValue({ id: 'a-1', unitId: 'unit-1' }),
  };
  const ticketRepo = {
    existsAssignmentForTechnician: jest.fn().mockResolvedValue(true),
  };

  const policy = new TicketAuthorizationPolicy(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    membershipQuery as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    residentUnitAssignmentRepo as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ticketRepo as any,
  );

  return { policy, membershipQuery, residentUnitAssignmentRepo, ticketRepo };
}

async function expectDomainError(
  promise: Promise<unknown>,
  code: string,
  status: number,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
  await promise.catch((error: { getStatus(): number }) => {
    expect(error.getStatus()).toBe(status);
  });
}

describe('TicketAuthorizationPolicy', () => {
  describe('assertCanCreate', () => {
    it('TECHNICIAN her zaman reddedilir (genel FORBIDDEN)', async () => {
      const { policy } = buildPolicy();
      await expectDomainError(
        policy.assertCanCreate(actor('TECHNICIAN'), buildFacility() as never, {} as never),
        'FORBIDDEN',
        403,
      );
    });

    it("RESIDENT kendi aktif unit assignment'ina eslesen UNIT icin olusturabilir", async () => {
      const { policy } = buildPolicy();
      await expect(
        policy.assertCanCreate(actor('RESIDENT'), buildFacility() as never, {} as never),
      ).resolves.toBeUndefined();
    });

    it('RESIDENT UNIT-disi bir facility icin FACILITY_NOT_FOUND (404) alir', async () => {
      const { policy } = buildPolicy();
      await expectDomainError(
        policy.assertCanCreate(
          actor('RESIDENT'),
          buildFacility({ type: 'COMMON_AREA' }) as never,
          {} as never,
        ),
        'FACILITY_NOT_FOUND',
        404,
      );
    });

    it('RESIDENT baska bir unit icin FACILITY_NOT_FOUND (404) alir', async () => {
      const { policy, residentUnitAssignmentRepo } = buildPolicy();
      residentUnitAssignmentRepo.findActiveForUser.mockResolvedValue({
        id: 'a-1',
        unitId: 'baska-unit',
      });
      await expectDomainError(
        policy.assertCanCreate(actor('RESIDENT'), buildFacility() as never, {} as never),
        'FACILITY_NOT_FOUND',
        404,
      );
    });

    it('SITE_MANAGER kendi sitesindeki facility icin olusturabilir', async () => {
      const { policy } = buildPolicy();
      await expect(
        policy.assertCanCreate(actor('SITE_MANAGER'), buildFacility() as never, {} as never),
      ).resolves.toBeUndefined();
    });

    it('SITE_MANAGER yonetmedigi site icin FACILITY_NOT_FOUND (404) alir', async () => {
      const { policy, membershipQuery } = buildPolicy();
      membershipQuery.hasActiveManagerMembership.mockResolvedValue(false);
      await expectDomainError(
        policy.assertCanCreate(actor('SITE_MANAGER'), buildFacility() as never, {} as never),
        'FACILITY_NOT_FOUND',
        404,
      );
    });

    it('OPERATIONS kosulsuz olusturabilir', async () => {
      const { policy } = buildPolicy();
      await expect(
        policy.assertCanCreate(actor('OPERATIONS'), buildFacility() as never, {} as never),
      ).resolves.toBeUndefined();
    });
  });

  describe('assertCanRead', () => {
    it("RESIDENT kendi ticket'ini okuyabilir", async () => {
      const { policy } = buildPolicy();
      await expect(
        policy.assertCanRead(actor('RESIDENT', 'resident-1'), buildTicket(), {} as never),
      ).resolves.toBeUndefined();
    });

    it("RESIDENT baskasinin ticket'i icin TICKET_NOT_FOUND (404) alir", async () => {
      const { policy } = buildPolicy();
      await expectDomainError(
        policy.assertCanRead(actor('RESIDENT', 'baska-resident'), buildTicket(), {} as never),
        'TICKET_NOT_FOUND',
        404,
      );
    });

    it("tasinmis resident (aktif uyeligi yok) kendi ticket'i icin bile TICKET_NOT_FOUND alir", async () => {
      const { policy, membershipQuery } = buildPolicy();
      membershipQuery.hasActiveSiteMembership.mockResolvedValue(false);
      await expectDomainError(
        policy.assertCanRead(actor('RESIDENT', 'resident-1'), buildTicket(), {} as never),
        'TICKET_NOT_FOUND',
        404,
      );
    });

    it("SITE_MANAGER kendi yonettigi sitenin ticket'ini okuyabilir", async () => {
      const { policy } = buildPolicy();
      await expect(
        policy.assertCanRead(actor('SITE_MANAGER'), buildTicket(), {} as never),
      ).resolves.toBeUndefined();
    });

    it("SITE_MANAGER baska bir sitenin ticket'i icin TICKET_NOT_FOUND (404) alir", async () => {
      const { policy, membershipQuery } = buildPolicy();
      membershipQuery.hasActiveManagerMembership.mockResolvedValue(false);
      await expectDomainError(
        policy.assertCanRead(actor('SITE_MANAGER'), buildTicket(), {} as never),
        'TICKET_NOT_FOUND',
        404,
      );
    });

    it("TECHNICIAN kendi assignment'i olan ticket'i okuyabilir", async () => {
      const { policy } = buildPolicy();
      await expect(
        policy.assertCanRead(actor('TECHNICIAN'), buildTicket(), {} as never),
      ).resolves.toBeUndefined();
    });

    it("TECHNICIAN assignment'i olmayan ticket icin TICKET_NOT_FOUND (404) alir", async () => {
      const { policy, ticketRepo } = buildPolicy();
      ticketRepo.existsAssignmentForTechnician.mockResolvedValue(false);
      await expectDomainError(
        policy.assertCanRead(actor('TECHNICIAN'), buildTicket(), {} as never),
        'TICKET_NOT_FOUND',
        404,
      );
    });

    it('OPERATIONS kosulsuz okuyabilir (aktif sozlesme sarti overrides.md #5 geregi yok)', async () => {
      const { policy } = buildPolicy();
      await expect(
        policy.assertCanRead(actor('OPERATIONS'), buildTicket(), {} as never),
      ).resolves.toBeUndefined();
    });
  });

  describe('assertCanUpdateFields', () => {
    it('operationNote gonderilirse OPERATIONS-disi rol icin genel FORBIDDEN (403) firlatir', () => {
      const { policy } = buildPolicy();
      expect(() =>
        policy.assertCanUpdateFields(actor('RESIDENT', 'resident-1'), buildTicket(), {
          operationNote: 'not',
          version: 0,
        } as never),
      ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    });

    it("RESIDENT sadece OPEN durumdaki kendi ticket'ini guncelleyebilir", () => {
      const { policy } = buildPolicy();
      expect(() =>
        policy.assertCanUpdateFields(actor('RESIDENT', 'resident-1'), buildTicket(), {
          title: 'yeni baslik',
          version: 0,
        } as never),
      ).not.toThrow();
    });

    it("RESIDENT non-OPEN kendi ticket'i icin TICKET_UPDATE_FORBIDDEN (403) alir", () => {
      const { policy } = buildPolicy();
      expect(() =>
        policy.assertCanUpdateFields(
          actor('RESIDENT', 'resident-1'),
          buildTicket({ status: 'TRIAGED' }),
          {
            title: 'yeni baslik',
            version: 0,
          } as never,
        ),
      ).toThrow(expect.objectContaining({ code: 'TICKET_UPDATE_FORBIDDEN' }));
    });

    it('SITE_MANAGER non-OPEN/TRIAGED ticket icin TICKET_UPDATE_FORBIDDEN (403) alir', () => {
      const { policy } = buildPolicy();
      expect(() =>
        policy.assertCanUpdateFields(actor('SITE_MANAGER'), buildTicket({ status: 'CANCELLED' }), {
          title: 'yeni baslik',
          version: 0,
        } as never),
      ).toThrow(expect.objectContaining({ code: 'TICKET_UPDATE_FORBIDDEN' }));
    });

    it('OPERATIONS herhangi bir durumda guncelleyebilir', () => {
      const { policy } = buildPolicy();
      expect(() =>
        policy.assertCanUpdateFields(actor('OPERATIONS'), buildTicket({ status: 'CANCELLED' }), {
          title: 'yeni baslik',
          operationNote: 'not',
          version: 0,
        } as never),
      ).not.toThrow();
    });

    it('icerik alani gonderilmezse (yalniz version) durum kontrolu atlanir', () => {
      const { policy } = buildPolicy();
      expect(() =>
        policy.assertCanUpdateFields(
          actor('RESIDENT', 'resident-1'),
          buildTicket({ status: 'CANCELLED' }),
          {
            version: 0,
          } as never,
        ),
      ).not.toThrow();
    });
  });
});
