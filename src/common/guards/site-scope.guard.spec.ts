import type { ExecutionContext } from '@nestjs/common';
import { DomainError } from '../errors/domain-error';
import { SiteScopeGuard } from './site-scope.guard';

function buildContext(params: Record<string, string>, user?: unknown): ExecutionContext {
  const request = { params, user };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function buildGuard(hasAccess: boolean) {
  const membershipQuery = { hasActiveManagerMembership: jest.fn().mockResolvedValue(hasAccess) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const guard = new SiteScopeGuard(membershipQuery as any);
  return { guard, membershipQuery };
}

describe('SiteScopeGuard', () => {
  it("':siteId' parametresi yoksa hata firlatir", async () => {
    const { guard } = buildGuard(true);
    await expect(
      guard.canActivate(buildContext({}, { id: 'u1', role: 'OPERATIONS' })),
    ).rejects.toThrow();
  });

  it('kullanici yoksa SITE_NOT_FOUND firlatir', async () => {
    const { guard } = buildGuard(true);
    await expect(
      guard.canActivate(buildContext({ siteId: 'site-1' }, undefined)),
    ).rejects.toMatchObject({ code: 'SITE_NOT_FOUND' });
  });

  it('OPERATIONS icin uyelik kontrolu yapmadan gecer (bypass)', async () => {
    const { guard, membershipQuery } = buildGuard(true);
    const context = buildContext({ siteId: 'site-1' }, { id: 'ops-1', role: 'OPERATIONS' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(membershipQuery.hasActiveManagerMembership).not.toHaveBeenCalled();
  });

  it('SITE_MANAGER aktif manager uyeligi varsa gecer', async () => {
    const { guard, membershipQuery } = buildGuard(true);
    const context = buildContext({ siteId: 'site-1' }, { id: 'sm-1', role: 'SITE_MANAGER' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(membershipQuery.hasActiveManagerMembership).toHaveBeenCalledWith('sm-1', 'site-1');
  });

  it('SITE_MANAGER uyeligi yoksa SITE_NOT_FOUND (404) firlatir - enumeration korumasi', async () => {
    const { guard } = buildGuard(false);
    const context = buildContext({ siteId: 'site-1' }, { id: 'sm-1', role: 'SITE_MANAGER' });

    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'SITE_NOT_FOUND' });
  });

  it('RESIDENT/TECHNICIAN rolu icin her zaman SITE_NOT_FOUND firlatir', async () => {
    const { guard } = buildGuard(true);
    const context = buildContext({ siteId: 'site-1' }, { id: 'r-1', role: 'RESIDENT' });

    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'SITE_NOT_FOUND' });
  });

  it("firlatilan hata DomainError instance'idir", async () => {
    const { guard } = buildGuard(false);
    const context = buildContext({ siteId: 'site-1' }, { id: 'sm-1', role: 'SITE_MANAGER' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(DomainError);
  });
});
