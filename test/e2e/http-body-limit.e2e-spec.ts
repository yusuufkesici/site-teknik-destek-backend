import { HttpStatus, ValidationPipe, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HTTP_BODY_LIMIT } from '../../src/common/constants/http-body-limit.constant';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../integration/setup/postgres-testcontainer';

// Faz 9 Slice 4: main.ts'teki acik JSON/urlencoded body limitinin davranis
// kaniti. Uygulama, bootstrap ile birebir ayni sekilde kurulur (ayni sabit,
// ayni useBodyParser cagrilari); boylece limit tek yerden
// (HTTP_BODY_LIMIT) yonetilmeye devam eder.
describe('HTTP body limit (E2E)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;

  beforeAll(async () => {
    testDb = await startTestDatabase();

    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    const expressApp = moduleRef.createNestApplication<NestExpressApplication>();
    expressApp.setGlobalPrefix('api/v1');
    expressApp.useBodyParser('json', { limit: HTTP_BODY_LIMIT });
    expressApp.useBodyParser('urlencoded', { extended: true, limit: HTTP_BODY_LIMIT });
    expressApp.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      }),
    );
    await expressApp.init();
    app = expressApp;
  }, 120000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase(testDb);
  });

  it('limit altindaki normal JSON istegi kabul edilir (200)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/otp/request')
      .send({ phoneNumber: '+905550009999' })
      .expect(HttpStatus.OK);
  });

  it("limitin (100kb) uzerindeki JSON body 413 doner (route'a ulasmadan)", async () => {
    const oversizedValue = 'x'.repeat(200 * 1024);

    await request(app.getHttpServer())
      .post('/api/v1/auth/otp/request')
      .send({ phoneNumber: oversizedValue })
      .expect(HttpStatus.PAYLOAD_TOO_LARGE)
      .expect((res) => {
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      });
  });

  it('multipart istekler JSON limitinden ETKILENMEZ (100kb ustu multipart 413 yerine guard 401 doner)', async () => {
    // 300kb'lik multipart govde json parser'a hic ugramaz (content-type
    // esleme geregi); istek route pipeline'ina ulasir ve kimlik dogrulama
    // olmadigi icin JwtAuthGuard 401 dondurur. Multer'in kendi 10 MB dosya
    // siniri (MAX_FILE_SIZE_BYTES) attachments e2e suite'inde ayrica
    // kanitlanir (11 MB -> 413 ATTACHMENT_TOO_LARGE).
    const largeFile = Buffer.alloc(300 * 1024, 0xab);

    await request(app.getHttpServer())
      .post('/api/v1/tickets/00000000-0000-4000-8000-000000000000/attachments')
      .field('attachmentType', 'ISSUE')
      .attach('file', largeFile, 'buyuk.jpg')
      .expect(HttpStatus.UNAUTHORIZED);
  });
});
