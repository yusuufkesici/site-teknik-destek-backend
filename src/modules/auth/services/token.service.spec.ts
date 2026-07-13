import { DomainError } from '../../../common/errors/domain-error';
import { AUTH_AUDIT_ACTIONS } from '../../../infrastructure/audit/auth-audit-actions.constant';
import { TokenService } from './token.service';

describe('TokenService', () => {
  const ctx = { ip: '127.0.0.1', userAgent: 'jest' };

  function buildService(txUserFindFirstResult: unknown = { role: 'RESIDENT', tokenVersion: 0 }) {
    const tx = { user: { findFirst: jest.fn().mockResolvedValue(txUserFindFirstResult) } };
    const prisma = { $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(tx)) };
    const refreshSessionRepo = {
      findByHashForUpdate: jest.fn(),
      revokeAllForUser: jest.fn().mockResolvedValue(undefined),
      revoke: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(undefined),
      markRotated: jest.fn().mockResolvedValue(undefined),
      revokeByHash: jest.fn(),
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const jwtService = { signAsync: jest.fn().mockResolvedValue('signed.jwt.token') };
    const config = {
      getOrThrow: jest.fn((key: string) => {
        const values: Record<string, unknown> = {
          'auth.jwtAccessSecrets': ['a'.repeat(32), 'b'.repeat(32)],
          'auth.jwtAccessExpiresInSeconds': 900,
          'auth.refreshTokenPepper': 'pepper-value-32-characters-min!!',
          'auth.refreshTokenExpiresInSeconds': 2592000,
        };
        return values[key];
      }),
    };

    const service = new TokenService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jwtService as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      refreshSessionRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      audit as any,
    );

    return { service, tx, prisma, refreshSessionRepo, audit, jwtService, config };
  }

  describe('signAccessToken', () => {
    it('ilk secret ile imzalar', async () => {
      const { service, jwtService } = buildService();
      await service.signAccessToken({
        sub: 'u1',
        role: 'RESIDENT',
        sessionId: 's1',
        tokenVersion: 0,
      });

      expect(jwtService.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'u1' }),
        expect.objectContaining({ secret: 'a'.repeat(32), algorithm: 'HS256' }),
      );
    });
  });

  describe('signAccessTokenWithCompensation', () => {
    it('imzalama basarisiz olursa refresh session revoke edilir ve hata yeniden firlatilir', async () => {
      const { service, jwtService, refreshSessionRepo } = buildService();
      jwtService.signAsync.mockRejectedValueOnce(new Error('sign failed'));

      await expect(
        service.signAccessTokenWithCompensation(
          { sub: 'u1', role: 'RESIDENT', sessionId: 's1', tokenVersion: 0 },
          's1',
        ),
      ).rejects.toThrow('sign failed');

      expect(refreshSessionRepo.revoke).toHaveBeenCalledWith(expect.anything(), 's1');
    });
  });

  describe('rotate', () => {
    it('session bulunamazsa AUTH_INVALID_REFRESH firlatir', async () => {
      const { service, refreshSessionRepo } = buildService();
      refreshSessionRepo.findByHashForUpdate.mockResolvedValue(null);

      await expect(service.rotate('raw-token', ctx)).rejects.toMatchObject({
        code: 'AUTH_INVALID_REFRESH',
      } satisfies Partial<DomainError>);
    });

    it('suresi dolmus session icin AUTH_INVALID_REFRESH firlatir', async () => {
      const { service, refreshSessionRepo } = buildService();
      refreshSessionRepo.findByHashForUpdate.mockResolvedValue({
        id: 's-old',
        userId: 'u1',
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      });

      await expect(service.rotate('raw-token', ctx)).rejects.toThrow(DomainError);
      expect(refreshSessionRepo.create).not.toHaveBeenCalled();
    });

    it('revoke edilmis (reuse) session icin tum session lar revoke edilir, audit yazilir ve transaction commit olur', async () => {
      const { service, refreshSessionRepo, audit } = buildService();
      refreshSessionRepo.findByHashForUpdate.mockResolvedValue({
        id: 's-old',
        userId: 'u1',
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 1000000),
      });

      await expect(service.rotate('raw-token', ctx)).rejects.toMatchObject({
        code: 'AUTH_INVALID_REFRESH',
      });

      expect(refreshSessionRepo.revokeAllForUser).toHaveBeenCalledWith(expect.anything(), 'u1');
      expect(audit.log).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: AUTH_AUDIT_ACTIONS.REFRESH_TOKEN_REUSE_DETECTED }),
      );
    });

    it('kullanici artik aktif degilse session revoke edilir ve AUTH_INVALID_REFRESH doner', async () => {
      const { service, refreshSessionRepo } = buildService(null);
      refreshSessionRepo.findByHashForUpdate.mockResolvedValue({
        id: 's-old',
        userId: 'u1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 1000000),
      });

      await expect(service.rotate('raw-token', ctx)).rejects.toMatchObject({
        code: 'AUTH_INVALID_REFRESH',
      });
      expect(refreshSessionRepo.revoke).toHaveBeenCalledWith(expect.anything(), 's-old');
    });

    it('basarili rotasyonda yeni session olusturulur, eski rotated isaretlenir, audit yazilir ve yeni JWT doner', async () => {
      const { service, refreshSessionRepo, audit, jwtService } = buildService({
        role: 'RESIDENT',
        tokenVersion: 2,
      });
      refreshSessionRepo.findByHashForUpdate.mockResolvedValue({
        id: 's-old',
        userId: 'u1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 1000000),
      });

      const result = await service.rotate('raw-token', ctx);

      expect(refreshSessionRepo.create).toHaveBeenCalledTimes(1);
      expect(refreshSessionRepo.markRotated).toHaveBeenCalledWith(
        expect.anything(),
        's-old',
        expect.any(String),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: AUTH_AUDIT_ACTIONS.REFRESH_TOKEN_ROTATED }),
      );
      expect(jwtService.signAsync).toHaveBeenCalledTimes(1);
      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.refreshToken).toEqual(expect.any(String));
      expect(result.expiresIn).toBe(900);
    });
  });

  describe('revoke (logout)', () => {
    it('token bulunursa revoke edilir ve audit yazilir', async () => {
      const { service, refreshSessionRepo, audit } = buildService();
      refreshSessionRepo.revokeByHash.mockResolvedValue({ id: 'session-1' });

      await service.revoke('raw-token');

      expect(audit.log).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: AUTH_AUDIT_ACTIONS.REFRESH_TOKEN_REVOKED,
          entityId: 'session-1',
        }),
      );
    });

    it('token bulunamazsa hata firlatmaz ve audit yazilmaz (enumeration korumasi)', async () => {
      const { service, refreshSessionRepo, audit } = buildService();
      refreshSessionRepo.revokeByHash.mockResolvedValue(null);

      await expect(service.revoke('unknown-token')).resolves.toBeUndefined();
      expect(audit.log).not.toHaveBeenCalled();
    });
  });
});
