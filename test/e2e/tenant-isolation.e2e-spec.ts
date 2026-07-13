import { HttpStatus, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../integration/setup/postgres-testcontainer';
import { CapturingSmsProvider } from './support/capturing-sms.provider';

describe('Tenant izolasyonu E2E (tam uygulama + Testcontainers)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let smsProvider: CapturingSmsProvider;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;

  beforeAll(async () => {
    testDb = await startTestDatabase();
  }, 120000);

  afterAll(async () => {
    await stopTestDatabase(testDb);
  });

  // Her 'it()' icin YENI bir Nest application instance'i (dolayisiyla YENI,
  // sifirlanmis bellek-ici RateLimiterService durumu) kurulur - ayni testin
  // birden fazla OTP akisi calistirmasi, RateLimiterMemory'nin (otpIp: 10
  // istek/600sn) paylasilan tek instance'ta tukenmesine yol acmasin diye
  // (butun supertest istekleri ayni IP'den gelir). Ayni Postgres testcontainer
  // yeniden kullanilarak container baslatma maliyeti tekrarlanmaz.
  beforeEach(async () => {
    const { AppModule } = await import('../../src/app.module');
    const { PrismaService } = await import(
      '../../src/infrastructure/database/prisma/prisma.service'
    );
    const { SMS_PROVIDER } = await import('../../src/infrastructure/sms/sms-provider.interface');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SMS_PROVIDER)
      .useClass(CapturingSmsProvider)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    smsProvider = app.get(SMS_PROVIDER);
    server = app.getHttpServer();
  }, 60000);

  afterEach(async () => {
    await app.close();
  });

  async function loginViaOtp(phone: string): Promise<{ accessToken: string; refreshToken: string }> {
    await request(server).post('/api/v1/auth/otp/request').send({ phoneNumber: phone }).expect(HttpStatus.OK);
    const code = smsProvider.getLastCode(phone);
    const res = await request(server)
      .post('/api/v1/auth/otp/verify')
      .send({ phoneNumber: phone, code })
      .expect(HttpStatus.OK);
    return { accessToken: res.body.accessToken, refreshToken: res.body.refreshToken };
  }

  async function createOperationsAndLogin(phone: string) {
    await prisma.user.create({
      data: { phoneNumber: phone, firstName: 'Ops', lastName: 'User', role: 'OPERATIONS' },
    });
    return loginViaOtp(phone);
  }

  async function createSiteManagerAndLogin(phone: string, siteId: string) {
    const user = await prisma.user.create({
      data: { phoneNumber: phone, firstName: 'Site', lastName: 'Manager', role: 'SITE_MANAGER' },
    });
    await prisma.siteMembership.create({
      data: { userId: user.id, siteId, membershipRole: 'MANAGER', isActive: true },
    });
    const tokens = await loginViaOtp(phone);
    return { user, ...tokens };
  }

  it('tam senaryo: facility olusturma, tenant izolasyonu, onboarding, profil ve pasiflestirme kurallari', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('+905554440001');

    // SITE_MANAGER site olusturamaz (RolesGuard, karar #2/#3).
    const smBootstrapSite = await request(server)
      .post('/api/v1/facilities/sites')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ name: 'Site A', code: 'TI-SITE-A' })
      .expect(HttpStatus.CREATED);
    const siteA = smBootstrapSite.body;

    const siteBRes = await request(server)
      .post('/api/v1/facilities/sites')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ name: 'Site B', code: 'TI-SITE-B' })
      .expect(HttpStatus.CREATED);
    const siteB = siteBRes.body;

    const blockARes = await request(server)
      .post(`/api/v1/facilities/sites/${siteA.id}/blocks`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ name: 'Blok 1', code: 'B1' })
      .expect(HttpStatus.CREATED);
    const unitARes = await request(server)
      .post(`/api/v1/facilities/blocks/${blockARes.body.id}/units`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ code: 'D-1' })
      .expect(HttpStatus.CREATED);
    const unitA = unitARes.body;

    const { accessToken: smAToken } = await createSiteManagerAndLogin('+905554440002', siteA.id);
    const { accessToken: smBToken } = await createSiteManagerAndLogin('+905554440003', siteB.id);

    // SITE_MANAGER site olusturamaz.
    await request(server)
      .post('/api/v1/facilities/sites')
      .set('Authorization', `Bearer ${smAToken}`)
      .send({ name: 'Yasak Site', code: 'FORBIDDEN' })
      .expect(HttpStatus.FORBIDDEN);

    // Site A yoneticisi Site B'nin kullanici listesini/agacini goremez (404).
    await request(server)
      .get(`/api/v1/sites/${siteB.id}/users`)
      .set('Authorization', `Bearer ${smAToken}`)
      .expect(HttpStatus.NOT_FOUND)
      .expect((res) => {
        expect(res.body.error.code).toBe('SITE_NOT_FOUND');
      });

    await request(server)
      .get(`/api/v1/facilities/sites/${siteB.id}/tree`)
      .set('Authorization', `Bearer ${smAToken}`)
      .expect(HttpStatus.NOT_FOUND);

    // Site A yoneticisi Site A'ya sakin ekler.
    const residentPhone = '+905554440010';
    const onboardRes = await request(server)
      .post(`/api/v1/sites/${siteA.id}/residents`)
      .set('Authorization', `Bearer ${smAToken}`)
      .send({ phoneNumber: residentPhone, firstName: 'Ilk', lastName: 'Isim', unitId: unitA.id })
      .expect(HttpStatus.CREATED);
    const residentId = onboardRes.body.id;

    // Sakin OTP ile giris yapabilir.
    const residentTokens = await loginViaOtp(residentPhone);
    expect(residentTokens.accessToken).toEqual(expect.any(String));

    // Idempotent re-onboarding: farkli ad/soyadla tekrar onboard edilirse
    // global profil SESSIZCE guncellenmez.
    await request(server)
      .post(`/api/v1/sites/${siteA.id}/residents`)
      .set('Authorization', `Bearer ${smAToken}`)
      .send({ phoneNumber: residentPhone, firstName: 'Farkli', lastName: 'Isim2', unitId: unitA.id })
      .expect(HttpStatus.CREATED);

    const meRes = await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${residentTokens.accessToken}`)
      .expect(HttpStatus.OK);
    expect(meRes.body.fullName).toBe('Ilk Isim');

    // Site B yoneticisi bu sakini goremez/degistiremez (404 - enumeration korumasi).
    await request(server)
      .get(`/api/v1/sites/${siteA.id}/users`)
      .set('Authorization', `Bearer ${smBToken}`)
      .expect(HttpStatus.NOT_FOUND);

    await request(server)
      .patch(`/api/v1/users/${residentId}`)
      .set('Authorization', `Bearer ${smBToken}`)
      .send({ firstName: 'Yetkisiz' })
      .expect(HttpStatus.NOT_FOUND)
      .expect((res) => {
        expect(res.body.error.code).toBe('USER_NOT_FOUND');
      });

    // Site A yoneticisi kendi sakininin adini degistirebilir.
    await request(server)
      .patch(`/api/v1/users/${residentId}`)
      .set('Authorization', `Bearer ${smAToken}`)
      .send({ firstName: 'Guncel' })
      .expect(HttpStatus.OK)
      .expect((res) => {
        expect(res.body.firstName).toBe('Guncel');
      });

    // SITE_MANAGER hedefi baska bir SITE_MANAGER ise 404 (karar #17).
    const otherManager = await prisma.user.create({
      data: { phoneNumber: '+905554440004', firstName: 'Diger', lastName: 'Yonetici', role: 'SITE_MANAGER' },
    });
    await prisma.siteMembership.create({
      data: { userId: otherManager.id, siteId: siteA.id, membershipRole: 'MANAGER', isActive: true },
    });
    await request(server)
      .patch(`/api/v1/users/${otherManager.id}`)
      .set('Authorization', `Bearer ${smAToken}`)
      .send({ firstName: 'Yasak' })
      .expect(HttpStatus.NOT_FOUND);

    // Site-scoped pasiflestirme: sakin Site A'dan cikarilir ama baska aktif
    // uyeligi kalmadigindan artik OTP eligibility'si false olmali. Ayni
    // telefon icin HTTP uzerinden ikinci bir OTP istegi burada yapilmiyor -
    // biraz once ayni testte yapilan ilk istekten dolayi 60sn'lik resend
    // cooldown'i zaten devrede olur; bu da "eligibility false" ile "cooldown
    // aktif" sebeplerini ayirt edilemez kilar. Bu yuzden eligibility
    // dogrudan servis katmaninda dogrulanir.
    await request(server)
      .post(`/api/v1/sites/${siteA.id}/users/${residentId}/deactivate`)
      .set('Authorization', `Bearer ${smAToken}`)
      .send({ reason: 'tasindi' })
      .expect(HttpStatus.NO_CONTENT);

    const { MembershipQueryService } = await import(
      '../../src/modules/memberships/membership-query.service'
    );
    const membershipQuery = app.get(MembershipQueryService);
    await expect(membershipQuery.hasAnyActiveSiteMembership(residentId)).resolves.toBe(false);

    const deactivatedUser = await prisma.user.findUniqueOrThrow({ where: { id: residentId } });
    expect(deactivatedUser.isActive).toBe(true);
  }, 60000);

  it('coklu-site uyelik: bir sitede site-scoped pasiflestirme digerindeki erisimi etkilemez', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('+905554440101');

    const siteARes = await request(server)
      .post('/api/v1/facilities/sites')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ name: 'Site MA', code: 'TI-MULTI-A' })
      .expect(HttpStatus.CREATED);
    const siteCRes = await request(server)
      .post('/api/v1/facilities/sites')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ name: 'Site MC', code: 'TI-MULTI-C' })
      .expect(HttpStatus.CREATED);
    const siteA = siteARes.body;
    const siteC = siteCRes.body;

    const { accessToken: smAToken } = await createSiteManagerAndLogin('+905554440102', siteA.id);

    const residentPhone = '+905554440110';
    const resident = await prisma.user.create({
      data: { phoneNumber: residentPhone, firstName: 'Coklu', lastName: 'Site', role: 'RESIDENT' },
    });
    await prisma.siteMembership.create({
      data: { userId: resident.id, siteId: siteA.id, membershipRole: 'RESIDENT', isActive: true },
    });
    await prisma.siteMembership.create({
      data: { userId: resident.id, siteId: siteC.id, membershipRole: 'RESIDENT', isActive: true },
    });

    const firstLogin = await loginViaOtp(residentPhone);
    expect(firstLogin.accessToken).toEqual(expect.any(String));

    await request(server)
      .post(`/api/v1/sites/${siteA.id}/users/${resident.id}/deactivate`)
      .set('Authorization', `Bearer ${smAToken}`)
      .send({ reason: 'site A cikisi' })
      .expect(HttpStatus.NO_CONTENT);

    // Site C'deki uyeligi hala aktif oldugundan OTP eligibility'si (Faz 2
    // OtpService.checkRateLimitsAndEligibility'nin kullandigi
    // MembershipQueryService.hasAnyActiveSiteMembership) hala true olmali.
    // Ayni telefon icin HTTP uzerinden ikinci bir OTP istegi burada
    // yapilmiyor - 60sn'lik resend cooldown limiter'i (dogru/beklenen
    // anti-abuse davranisi) ayni testte hemen ardindan gelen ikinci istegi
    // zaten reddeder; bu yuzden dogrudan servis katmaninda dogrulanir.
    const { MembershipQueryService } = await import(
      '../../src/modules/memberships/membership-query.service'
    );
    const membershipQuery = app.get(MembershipQueryService);
    await expect(membershipQuery.hasAnyActiveSiteMembership(resident.id)).resolves.toBe(true);

    const siteAMembership = await prisma.siteMembership.findFirstOrThrow({
      where: { userId: resident.id, siteId: siteA.id },
    });
    expect(siteAMembership.isActive).toBe(false);
    const siteCMembership = await prisma.siteMembership.findFirstOrThrow({
      where: { userId: resident.id, siteId: siteC.id },
    });
    expect(siteCMembership.isActive).toBe(true);
  }, 60000);

  it('OPERATIONS global pasiflestirme: kullanici bir daha OTP dogrulamasi yapamaz', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('+905554440201');

    const residentPhone = '+905554440210';
    const resident = await prisma.user.create({
      data: { phoneNumber: residentPhone, firstName: 'Global', lastName: 'Pasif', role: 'RESIDENT' },
    });
    const site = await prisma.facility.create({
      data: { type: 'SITE', name: 'Site GD', code: 'TI-GLOBAL-D' },
    });
    await prisma.siteMembership.create({
      data: { userId: resident.id, siteId: site.id, membershipRole: 'RESIDENT', isActive: true },
    });

    const { refreshToken } = await loginViaOtp(residentPhone);

    await request(server)
      .post(`/api/v1/users/${resident.id}/deactivate`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ reason: 'kural ihlali' })
      .expect(HttpStatus.NO_CONTENT);

    await request(server)
      .post('/api/v1/auth/token/refresh')
      .send({ refreshToken })
      .expect(HttpStatus.UNAUTHORIZED)
      .expect((res) => {
        expect(res.body.error.code).toBe('AUTH_INVALID_REFRESH');
      });

    const deactivated = await prisma.user.findUniqueOrThrow({ where: { id: resident.id } });
    expect(deactivated.isActive).toBe(false);
  }, 60000);
});
