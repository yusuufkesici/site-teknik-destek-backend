import 'reflect-metadata';
import { HttpStatus, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { HTTP_BODY_LIMIT } from './common/constants/http-body-limit.constant';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService);
  const port = config.getOrThrow<number>('app.port');
  const apiPrefix = config.getOrThrow<string>('app.apiPrefix');
  const allowedOrigins = config.getOrThrow<string[]>('cors.allowedOrigins');

  app.setGlobalPrefix(apiPrefix);

  app.use(helmet());

  // Faz 9 Slice 4: JSON/urlencoded body limiti acikca tanimlanir (Express
  // varsayilanina ortuk guven yok). useBodyParser ile burada kaydedilen
  // 'jsonParser'/'urlencodedParser' middleware'leri, Nest'in init sirasindaki
  // varsayilan parser kaydini ayni-isim kontrolu sayesinde devre disi
  // birakir; boylece cift parser olusmaz. Multipart (attachment) istekleri
  // bu limitten etkilenmez - Multer siniri ayridir (MAX_FILE_SIZE_BYTES).
  app.useBodyParser('json', { limit: HTTP_BODY_LIMIT });
  app.useBodyParser('urlencoded', { extended: true, limit: HTTP_BODY_LIMIT });

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    }),
  );

  // Faz 8 Dilim 1 (onaylanan docs/phase-8-plan.md Bolum 1/10.1): bu
  // olmadan OnModuleDestroy/OnApplicationShutdown SIGTERM/SIGINT'te hic
  // tetiklenmez - OutboxRelay/NotificationDeliveryRelay'in graceful
  // drain'i buna bagimlidir.
  app.enableShutdownHooks();

  await app.listen(port);
}

void bootstrap();
