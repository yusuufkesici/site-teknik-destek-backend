import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

const SUB = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';

describe('JwtAuthGuard', () => {
  function buildContext(headers: Record<string, string> = {}): ExecutionContext {
    const request = { headers, ip: '127.0.0.1' };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({}),
      }),
      getHandler: () => function handler() {},
      getClass: () => class TestController {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  function buildGuard(options: {
    isPublic?: boolean;
    userTokenVersion?: number;
    userExists?: boolean;
  }) {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(options.isPublic ?? false) };
    const jwtService = { verifyAsync: jest.fn() };
    const config = {
      getOrThrow: jest.fn().mockReturnValue(['a'.repeat(32), 'b'.repeat(32)]),
    };
    const user =
      options.userExists === false
        ? null
        : {
            id: SUB,
            role: 'RESIDENT',
            isActive: true,
            tokenVersion: options.userTokenVersion ?? 0,
            firstName: 'A',
            lastName: 'B',
          };
    const userAuthRepo = { findActiveById: jest.fn().mockResolvedValue(user) };
    const prisma = {};

    const guard = new JwtAuthGuard(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reflector as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jwtService as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userAuthRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
    );

    return { guard, reflector, jwtService, config, userAuthRepo };
  }

  function validPayload(overrides: Record<string, unknown> = {}) {
    return { sub: SUB, role: 'RESIDENT', sessionId: SESSION_ID, tokenVersion: 0, ...overrides };
  }

  it('@Public() rotalarda token kontrolu yapmadan gecer', async () => {
    const { guard, jwtService } = buildGuard({ isPublic: true });
    const context = buildContext();

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(jwtService.verifyAsync).not.toHaveBeenCalled();
  });

  it('Authorization header yoksa 401 firlatir', async () => {
    const { guard } = buildGuard({});
    await expect(guard.canActivate(buildContext())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('Bearer semasi disinda bir header 401 firlatir', async () => {
    const { guard } = buildGuard({});
    const context = buildContext({ authorization: 'Basic abcdef' });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('hicbir secret ile dogrulanamayan token 401 firlatir', async () => {
    const { guard, jwtService } = buildGuard({});
    jwtService.verifyAsync.mockRejectedValue(new Error('invalid signature'));
    const context = buildContext({ authorization: 'Bearer sometoken' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jwtService.verifyAsync).toHaveBeenCalledTimes(2); // iki secret de denendi
  });

  it('ikinci secret ile dogrulanan token (rotasyon) kabul edilir', async () => {
    const { guard, jwtService } = buildGuard({});
    jwtService.verifyAsync
      .mockRejectedValueOnce(new Error('invalid signature'))
      .mockResolvedValueOnce(validPayload());
    const context = buildContext({ authorization: 'Bearer sometoken' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('algoritma acikca HS256 ile sinirlandirilir', async () => {
    const { guard, jwtService } = buildGuard({});
    jwtService.verifyAsync.mockResolvedValue(validPayload());
    const context = buildContext({ authorization: 'Bearer sometoken' });

    await guard.canActivate(context);

    expect(jwtService.verifyAsync).toHaveBeenCalledWith(
      'sometoken',
      expect.objectContaining({ algorithms: ['HS256'] }),
    );
  });

  it.each([
    ['sub UUID degilse', validPayload({ sub: 'not-a-uuid' })],
    ['sessionId UUID degilse', validPayload({ sessionId: 'not-a-uuid' })],
    ['role UserRole enum disindaysa', validPayload({ role: 'SUPERADMIN' })],
    ['tokenVersion negatifse', validPayload({ tokenVersion: -1 })],
    ['tokenVersion tam sayi degilse', validPayload({ tokenVersion: 1.5 })],
  ])('gecersiz payload sekli (%s) generic 401 doner', async (_label, payload) => {
    const { guard, jwtService } = buildGuard({});
    jwtService.verifyAsync.mockResolvedValue(payload);
    const context = buildContext({ authorization: 'Bearer sometoken' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('DB tokenVersion payload ile uyusmuyorsa 401 firlatir', async () => {
    const { guard, jwtService } = buildGuard({ userTokenVersion: 5 });
    jwtService.verifyAsync.mockResolvedValue(validPayload({ tokenVersion: 0 }));
    const context = buildContext({ authorization: 'Bearer sometoken' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('kullanici bulunamazsa (silinmis/pasif) 401 firlatir', async () => {
    const { guard, jwtService } = buildGuard({ userExists: false });
    jwtService.verifyAsync.mockResolvedValue(validPayload());
    const context = buildContext({ authorization: 'Bearer sometoken' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('gecerli token ve eslesen tokenVersion icin request.user set edilir', async () => {
    const { guard, jwtService } = buildGuard({ userTokenVersion: 0 });
    jwtService.verifyAsync.mockResolvedValue(validPayload());
    const request = { headers: { authorization: 'Bearer sometoken' }, ip: '127.0.0.1' } as {
      headers: Record<string, string>;
      ip: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      user?: any;
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
      getHandler: () => function handler() {},
      getClass: () => class TestController {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await guard.canActivate(context);

    expect(request.user).toEqual({
      id: SUB,
      role: 'RESIDENT',
      sessionId: SESSION_ID,
      tokenVersion: 0,
    });
  });
});
